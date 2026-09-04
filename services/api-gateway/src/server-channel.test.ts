/** The gateway over HTTP: channel messages, mentions and auto-claim. */

import assert from "node:assert/strict";
import {
  randomBytes,
} from "node:crypto";
import net from "node:net";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  type ApiOperations,
  narrateTaskEvent,
  normaliseThreadTitle,
  readsAsQuestion,
  requestFromObjective,
  summariseObjective,
  summariseThreadTitle,
} from "./server.js";
import {
  PASSWORD,
  TestClient,
  addColleague,
  agentSpeech,
  autoClaim,
  bootstrap,
  decodeTextFrames,
  invitableRepository,
  joinAllConnectedAgents,
  registerAccount,
  startRuntime,
  waitFor,
  withLocalAgentsOnly,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("the repository channel round-trips messages, replies, reactions, reads, and agent overrides", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "channel-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const empty = await owner.request(`${base}/messages`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.messages, []);
  assert.deepEqual(empty.data.agentOverrides, {});
  assert.equal(empty.data.readAt, undefined);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    // References are trusted server metadata, not a new client-authored
    // field. An extra body key is ignored just as unknown keys were before.
    body: {
      content: "  Kicking off this channel.  ",
      referencedMessageId: "chanmsg_spoofed",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(posted.data.message.content, "Kicking off this channel.");
  assert.equal(posted.data.message.kind, "user");
  assert.equal(posted.data.message.referencedMessageId, undefined);
  const messageId = posted.data.message.id;

  // An empty message is not a message at all.
  const blank = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "   " },
  });
  assert.equal(blank.status, 400);

  const reply = await owner.request(`${base}/messages/${messageId}/replies`, {
    method: "POST",
    body: { content: "First reply." },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.reply.messageId, messageId);

  const reacted = await owner.request(
    `${base}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji: "🎉" } },
  );
  assert.equal(reacted.status, 200);
  assert.equal(reacted.data.message.reactions["🎉"].count, 1);
  assert.equal(reacted.data.message.reactions["🎉"].mine, true);

  // Toggling the same emoji again removes it.
  const unreacted = await owner.request(
    `${base}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji: "🎉" } },
  );
  assert.equal(unreacted.data.message.reactions["🎉"], undefined);

  const named = await owner.request(`${base}/agents/agent_1`, {
    method: "POST",
    body: { name: "Scout" },
  });
  assert.equal(named.status, 200);
  assert.equal(named.data.override.name, "Scout");

  const read = await owner.request(`${base}/read`, { method: "POST" });
  assert.equal(read.status, 200);
  assert.equal(typeof read.data.readAt, "string");

  const after = await owner.request(`${base}/messages`);
  assert.equal(after.data.messages.length, 1);
  assert.equal(after.data.messages[0].replies.length, 1);
  // Stored against the agent, not the vendor. A bare id reaching the write
  // can only be the caller's own agent, so it is resolved against them —
  // otherwise the row names every agent on that provider and one person's
  // rename lands on their colleague's agent too.
  assert.equal(
    after.data.agentOverrides[`${bootstrapped.user.id}:agent_1`].name,
    "Scout",
    JSON.stringify(after.data.agentOverrides),
  );
  assert.equal(after.data.agentOverrides["agent_1"], undefined);
  assert.equal(after.data.readAt, read.data.readAt);

  // Replying to, or reacting on, a message that does not exist is a 404, not
  // a crash.
  const missing = await owner.request(
    `${base}/messages/does-not-exist/replies`,
    { method: "POST", body: { content: "orphan" } },
  );
  assert.equal(missing.status, 404);
});

test("channel messages pin, surface in the payload, and unpin", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "pin-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Deploy checklist lives here." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  const pinned = await owner.request(`${base}/messages/${messageId}/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
  assert.equal(typeof pinned.data.message.pinnedAt, "string");
  assert.equal(pinned.data.message.pinnedBy, bootstrapped.user.id);

  // The channel payload carries the pinned list alongside the transcript, so
  // the banner never depends on the pinned row being inside the page window.
  const listed = await owner.request(`${base}/messages`);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.pinned.length, 1);
  assert.equal(listed.data.pinned[0].id, messageId);
  assert.equal(listed.data.pinned[0].pinnedBy, bootstrapped.user.id);

  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.some(
      (event) =>
        event.type === "channel_message_pinned" &&
        event.data["messageId"] === messageId &&
        event.data["pinned"] === true &&
        event.data["repositoryId"] === repositoryId,
    ),
  );

  // The same route toggles: pinning again unpins, and the audit says so.
  const unpinned = await owner.request(`${base}/messages/${messageId}/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(unpinned.status, 200);
  assert.equal(unpinned.data.message.pinnedAt, undefined);
  assert.equal(unpinned.data.message.pinnedBy, undefined);

  const cleared = await owner.request(`${base}/messages`);
  assert.deepEqual(cleared.data.pinned, []);
  const auditAfter = await runtime.store.listAudit();
  assert.ok(
    auditAfter.some(
      (event) =>
        event.type === "channel_message_pinned" &&
        event.data["messageId"] === messageId &&
        event.data["pinned"] === false,
    ),
  );

  // Pinning a message that does not exist is a 404, not a crash.
  const missing = await owner.request(`${base}/messages/does-not-exist/pin`, {
    method: "POST",
    body: {},
  });
  assert.equal(missing.status, 404);
});

test("the repository channel is scoped by repository access, like everything else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "private-repo");

  // Registration gives this account its own organization and project — it
  // has no membership, and no grant, on the owner's repository.
  const newcomer = new TestClient(runtime.origin);
  await registerAccount(runtime.store, newcomer, {
    email: "outsider@example.com",
    displayName: "Outsider",
    password: PASSWORD,
  });

  // This newcomer has no membership and no grant in the owner's organization
  // at all, so `authorizeRepository` refuses at the project level — the same
  // 403 a totally unrelated stranger gets from every other project-scoped
  // route (see "a stranger with no grant and no membership still sees
  // nothing" above). The disguised-as-404 behavior is reserved for someone
  // who *can* reach the project but not this particular repository.
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const blockedList = await newcomer.request(`${base}/messages`);
  assert.equal(blockedList.status, 403);
  const blockedPost = await newcomer.request(`${base}/messages`, {
    method: "POST",
    body: { content: "sneaking in" },
  });
  assert.equal(blockedPost.status, 403);

  // The owner's own view is unaffected.
  const ownersView = await owner.request(`${base}/messages`);
  assert.equal(ownersView.status, 200);
});

test("the channel roster is the real connected agents of everyone with access to the repository", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "roster-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Reached through an organization role — the same source `authorizeProject`
  // reads when nobody named a narrower grant.
  const colleague = await runtime.store.createUser({
    email: "colleague@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });

  // Reached through a per-repository grant and *no* organization role at
  // all — the other source `authorizeRepository` accepts, and the whole
  // reason grants exist: sharing one repository without joining the team.
  const guest = await runtime.store.createUser({
    email: "guest@example.com",
    displayName: "Guest Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });

  // Has agents connected, but no membership and no grant on this repository
  // at all. Their connections exist in the same fixture map everyone else's
  // do, so this only proves something if the route actually checks access
  // rather than just echoing whatever `connectionsFor` was asked about.
  const stranger = await runtime.store.createUser({
    email: "stranger-roster@example.com",
    displayName: "Stranger",
    passwordDigest: await hashPassword(PASSWORD),
  });

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  runtime.chatConnections.set(colleague.id, [
    { provider: "openai" },
    { provider: "google" },
  ]);
  runtime.chatConnections.set(guest.id, [{ provider: "anthropic" }]);
  runtime.chatConnections.set(stranger.id, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const roster = await owner.request(`${base}/agents`);
  assert.equal(roster.status, 200);

  const byUser = new Map<string, string[]>();
  for (const entry of roster.data.agents as any[]) {
    assert.equal(entry.connected, true);
    // The safe-to-browser shape only: no secret, no hint, no credential kind,
    // no free-text label the credential's own owner chose for themselves.
    for (const forbidden of ["secret", "hint", "kind", "label"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(entry, forbidden),
        false,
        `roster entry must not carry "${forbidden}"`,
      );
    }
    const list = byUser.get(entry.userId) ?? [];
    list.push(entry.provider);
    byUser.set(entry.userId, list);
  }

  assert.deepEqual(byUser.get(bootstrapped.user.id)?.sort(), ["anthropic"]);
  assert.deepEqual(byUser.get(colleague.id)?.sort(), ["google", "openai"]);
  assert.deepEqual(byUser.get(guest.id)?.sort(), ["anthropic"]);
  // The whole point: a stranger's connected agents never surface on a
  // repository they cannot reach, no matter what the credential store knows.
  assert.equal(byUser.has(stranger.id), false);

  const guestEntry = (roster.data.agents as any[]).find(
    (entry) => entry.userId === guest.id,
  );
  assert.equal(guestEntry.userName, "Guest Dev");

  // Every collaborator sees the same roster — a colleague's own agent is not
  // theirs, but a shared channel roster is meaningless if they cannot see it.
  const colleagueClient = new TestClient(runtime.origin);
  await colleagueClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const colleagueView = await colleagueClient.request(`${base}/agents`);
  assert.equal(colleagueView.status, 200);
  assert.deepEqual(
    (colleagueView.data.agents as any[]).map((entry) => entry.userId).sort(),
    (roster.data.agents as any[]).map((entry) => entry.userId).sort(),
  );

  // The stranger cannot even ask: no membership and no grant on this
  // repository, the same 403 every other project-scoped route gives someone
  // who cannot reach the project at all.
  const strangerClient = new TestClient(runtime.origin);
  await registerAccount(runtime.store, strangerClient, {
    email: "outsider-roster@example.com",
    displayName: "Outsider",
    password: PASSWORD,
  });
  const blocked = await strangerClient.request(`${base}/agents`);
  assert.equal(blocked.status, 403);
});

test("posting to the repository channel broadcasts over the existing event socket", async (t) => {
  const runtime = await startRuntime(t, { webSocketPollIntervalMs: 10 });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "live-repo");

  // Simulates the case the frontend cares about: a second browser tab already
  // has the channel's event socket open when a message is posted, and must
  // see it appear without polling or a refresh.
  const payloads = await new Promise<any[]>((resolve, reject) => {
    const socket = net.createConnection(runtime.port, "127.0.0.1");
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBytes = Buffer.alloc(0);
    let posted = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the channel message to broadcast"));
    }, 4_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/v1/events?projectId=${DEFAULT_PROJECT_ID}&after=0 HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${runtime.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${runtime.origin}\r\n` +
          `Cookie: ${owner.cookieHeader}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        if (!headersRead) {
          response = Buffer.concat([response, chunk]);
          const boundary = response.indexOf("\r\n\r\n");
          if (boundary < 0) {
            return;
          }
          assert.match(
            response.subarray(0, boundary).toString("ascii"),
            /^HTTP\/1\.1 101 /u,
          );
          frameBytes = response.subarray(boundary + 4);
          headersRead = true;
        } else {
          frameBytes = Buffer.concat([frameBytes, chunk]);
        }
        const messages = decodeTextFrames(frameBytes).map((entry) =>
          JSON.parse(entry),
        );
        if (messages.some((entry) => entry.type === "connected") && !posted) {
          posted = true;
          void owner
            .request(
              `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
              { method: "POST", body: { content: "Hello, second tab." } },
            )
            .catch(reject);
        }
        if (
          messages.some(
            (entry) =>
              entry.type === "audit" &&
              entry.event?.type === "channel_message_posted" &&
              entry.event?.data?.repositoryId === repositoryId,
          )
        ) {
          clearTimeout(timer);
          socket.destroy();
          resolve(messages);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(
    payloads.some(
      (entry) => entry.type === "audit" && entry.event?.type === "channel_message_posted",
    ),
    true,
  );
});

/**
 * Adds a colleague with organization-role access to the owner's repository —
 * the same shape the roster tests above use — and returns a logged-in client
 * for them, for the @mention dispatch tests below.
 */
test("a personal agent refuses a stranger's @mention and dispatches nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-personal-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // "Owner"'s connected Claude is personal — the default, and what every
  // connection had before visibility existed.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const colleague = await addColleague(runtime, "colleague-personal@example.com");

  // The exact text the frontend's mention-autocomplete would have inserted:
  // "@" + `${AGENT_LABEL[provider]} (${firstWord(displayName)})`.
  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the login bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // The whole point: nothing was submitted under anyone's account.
  assert.equal(runtime.submittedTasks.length, 0);

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].content, /personal to Owner/u);
  assert.match(systemMessages[0].content, /@Claude \(Owner\)/u);
  // The stranger's own message still posted — a refused mention must not
  // also swallow what they typed.
  assert.equal(
    (after.data.messages as any[]).some(
      (message) => message.content === "@Claude (Owner) please fix the login bug",
    ),
    true,
  );
});

/**
 * The same refusal, reached by the door that used to be open.
 *
 * `/dnc` takes a fast path in the mention loop: it calls `answerInChannel`
 * directly and `continue`s, which also skips `dispatchOneMention` — the only
 * place the personal-agent refusal above lives. So a stranger could spend
 * somebody else's provider credential on a full turn, up to the question
 * deadline, from any room they could post in. The mention path was tested and
 * the slash-command path was not, which is the whole of how it survived.
 *
 * Asserted on `chatPrompts` being empty, not just on the refusal appearing: a
 * refusal posted after the turn was made would read identically in the
 * channel and cost exactly the same.
 */
test("/dnc cannot reach a stranger's personal agent either", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-personal-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "This turn must never be made.";

  const colleague = await addColleague(runtime, "colleague-dnc@example.com");

  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) what does the retry loop do?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.deepEqual(
    runtime.chatPrompts,
    [],
    "a refused /dnc must not reach the provider at all",
  );
  assert.equal(runtime.submittedTasks.length, 0);

  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 1, JSON.stringify(after.data.messages));
  assert.match(systemMessages[0].content, /personal to Owner/u);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.deepEqual(agentMessages, [], JSON.stringify(agentMessages));
});

/**
 * The other half: `/dnc` must still work where it always did.
 *
 * The fix is a visibility condition on a fast path, and the way to get it
 * wrong is to make it too broad — filtering the mention list rather than the
 * one branch, and quietly disabling the command for everybody.
 */
test("/dnc still answers on an org-wide agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-org-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "It caps at five attempts.";

  const colleague = await addColleague(runtime, "colleague-dnc-org@example.com");

  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) what does the retry loop do?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const [answer] = agentSpeech(after.data.messages);
  assert.match(String(answer?.content), /caps at five attempts/u);
  assert.equal(runtime.submittedTasks.length, 0, "/dnc files no task");
});

test("an org-wide agent accepts a stranger's @mention and dispatches under the owner's credential", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-org-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const colleague = await addColleague(runtime, "colleague-org@example.com");

  const posted = await colleague.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the login bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1);
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  // Dispatched under the *mentioned agent's owner*, never the mentioner —
  // the whole reason `actorId` here is not simply `principal.user.id`.
  assert.equal(task.actorId, bootstrapped.user.id);
  assert.notEqual(task.actorId, colleague.id);
  assert.equal(task.vendor, "claude");
  assert.match(task.objective, /please fix the login bug/u);

  const after = await owner.request(`${base}/messages`);
  const [acknowledgement] = agentSpeech(after.data.messages);
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(
    acknowledgement?.authorId,
    `${bootstrapped.user.id}:anthropic`,
  );
});

test("dispatch locally names the thread, then contextualizes the same reply", async (t) => {
  const titlePrompts: string[] = [];
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async (prompt) => {
      titlePrompts.push(prompt);
      return "Token refresh reliability";
    },
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-own-voice");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const assigned = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "Token Reliability Engineer" },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  runtime.chatAnswer.text =
    "I'll inspect the refresh flow, update the retry behavior, and verify it with focused tests.";
  // The acknowledgement must not wait for this contextual opening to finish.
  runtime.chatAnswer.delayMs = 500;

  const attachmentId = `${"a".repeat(32)}.png`;
  const visibleRequest =
    `please fix the token refresh ` +
    `![trace](attachment:${attachmentId})`;
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Claude (Owner) ${visibleRequest}` },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const speech = agentSpeech(after.data.messages);
  assert.equal(speech.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    speech[0]?.content,
    "I've taken this task and I'm working on it.",
  );
  const acknowledgementId = speech[0]?.id;
  const acknowledgementCreatedAt = speech[0]?.createdAt;
  const auditCountBeforeContext = (await runtime.store.listAudit()).filter(
    (event) =>
      event.type === "channel_message_posted" &&
      event.data["messageId"] === posted.data.message.id,
  ).length;
  assert.equal(runtime.submittedTasks.length, 1);
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Token refresh reliability",
      ),
    );
  }, "the local title was not persisted in the task thread");
  assert.equal(titlePrompts.length, 1);
  assert.ok((titlePrompts[0] ?? "").endsWith(`Request:\n${visibleRequest}`));
  assert.doesNotMatch(
    titlePrompts[0] ?? "",
    /@Claude|Token Reliability Engineer|Your final message|open this file|\/var\/data/u,
  );
  const executionObjective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(executionObjective, /Token Reliability Engineer/u);
  assert.match(executionObjective, /Your final message/u);
  assert.match(executionObjective, /open this file/u);
  assert.match(executionObjective, /\/var\/data/u);
  assert.ok(
    runtime.chatPrompts.every(
      (entry) => !/only the acknowledgement|picking it up/iu.test(entry.prompt),
    ),
    JSON.stringify(runtime.chatPrompts),
  );

  const intent =
    "I'll inspect the refresh flow, update the retry behavior, and verify it with focused tests.";
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages)[0]?.content === intent;
  }, "the generic acknowledgement was not contextualized");
  const contextualized = agentSpeech(
    (await owner.request(`${base}/messages`)).data.messages,
  );
  assert.equal(contextualized.length, 1);
  assert.equal(contextualized[0]?.id, acknowledgementId);
  assert.equal(contextualized[0]?.createdAt, acknowledgementCreatedAt);
  assert.equal(contextualized[0]?.content, intent);
  const auditCountAfterContext = (await runtime.store.listAudit()).filter(
    (event) =>
      event.type === "channel_message_posted" &&
      event.data["messageId"] === posted.data.message.id,
  ).length;
  assert.equal(auditCountAfterContext, auditCountBeforeContext + 1);
});

test("provider opening failure does not prevent the local thread title", async (t) => {
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async () => "Token refresh repair",
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-context-failure");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.fail = "opening unavailable";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the token refresh" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () =>
      runtime.chatPrompts.some((entry) =>
        entry.prompt.includes("Reply with one or two concise first-person lines"),
      ),
    "the contextual opening was not attempted",
  );

  const speech = agentSpeech(
    (await owner.request(`${base}/messages`)).data.messages,
  );
  assert.equal(speech.length, 1);
  assert.equal(
    speech[0]?.content,
    "I've taken this task and I'm working on it.",
  );
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Token refresh repair",
      ),
    );
  }, "the local title disappeared with the failed provider opening");
});

test("work acknowledges inside the user request's thread", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ack-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) tighten the retry policy" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.id === posted.data.message.id,
  );
  assert.equal(thread?.kind, "user");
  assert.equal(thread?.content, "@Claude (Owner) tighten the retry policy");
  const acknowledgement = (thread?.replies ?? []).find(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(
    acknowledgement?.authorId,
    `${bootstrapped.user.id}:anthropic`,
  );
  assert.equal(runtime.submittedTasks.length, 1);
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(thread?.taskId, task?.id);
  const events = (await runtime.store.listAudit()).filter(
    (entry) =>
      entry.type === "channel_message_posted" &&
      entry.data["messageId"] === posted.data.message.id,
  );
  assert.ok(events.length >= 2, JSON.stringify(events));

  // A bare follow-up still reaches the agent attributed by the persisted
  // task and the acknowledgement.
  runtime.chatAnswer.text = "I'm working through the retry callers.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);
  await waitFor(async () => {
    const root = await runtime.store.getChannelMessage(
      repositoryId,
      posted.data.message.id,
      bootstrapped.user.id,
    );
    return (root?.replies ?? []).some(
      (reply) => reply.content === runtime.chatAnswer.text,
    );
  }, "the request-rooted thread lost its agent identity");
});

test("automatic continuation matches an existing user-rooted task thread", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "user-root-continue");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const content = "@Claude (Owner) rework the retry policy and its tests";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const bumpedRoots: string[] = [];
  const bumpChannelMessage = runtime.store.bumpChannelMessage.bind(
    runtime.store,
  );
  runtime.store.bumpChannelMessage = async (repo, messageId, at) => {
    bumpedRoots.push(messageId);
    await bumpChannelMessage(repo, messageId, at);
  };
  const second = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content },
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(runtime.submittedTasks.length, 2);

  const [firstSubmission, secondSubmission] = runtime.submittedTasks;
  assert.equal(firstSubmission?.conversationId, first.data.message.id);
  assert.equal(secondSubmission?.conversationId, first.data.message.id);
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    bootstrapped.user.id,
  );
  const root = messages.find((message) => message.id === first.data.message.id);
  const repeated = messages.find(
    (message) => message.id === second.data.message.id,
  );
  assert.equal(root?.kind, "user");
  assert.ok(root?.taskId !== undefined);
  assert.ok(repeated !== undefined);
  assert.equal(repeated.taskId, undefined);
  assert.deepEqual(
    bumpedRoots,
    [root.id],
    "a channel-originated continuation must still refresh the existing thread",
  );
  assert.ok(
    (root?.replies ?? []).some(
      (reply) => reply.kind === "user" && reply.content === content,
    ),
  );
  assert.equal(
    (root?.replies ?? []).filter((reply) => reply.kind === "agent").length,
    2,
    JSON.stringify(root?.replies),
  );
  assert.equal(
    (root?.replies ?? [])
      .filter((reply) => reply.kind === "agent")
      .every(
        (reply) =>
          reply.content === "I've taken this task and I'm working on it.",
      ),
    true,
  );
});

test("matching integrated work names its agent and points back without submitting a duplicate", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const objective = "implement the token refresh retry circuit breaker guard";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Alpha ${objective}` },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
      files: ["src/token-refresh.ts"],
    },
  });

  const submittedBefore = runtime.submittedTasks.length;
  const repeated = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Beta update the token refresh retry circuit breaker guard",
    },
  });
  assert.equal(repeated.status, 201, JSON.stringify(repeated.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore);

  const after = await owner.request(`${base}/messages?limit=50`);
  const reference = (after.data.messages as any[]).find(
    (message) =>
      message.kind === "agent" &&
      message.referencedMessageId === first.data.message.id,
  );
  assert.ok(reference !== undefined, JSON.stringify(after.data.messages));
  assert.equal(reference.authorId, `${bootstrapped.user.id}:openai`);
  assert.match(reference.content, /@Alpha already took care of that\.$/u);
});

test("completed-work recognition requires a canonical change", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-proof");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const objective = "implement the session refresh timeout guard";

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Alpha ${objective}` },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  // Reports use this same terminal status. With no promotion in the audit
  // record, it is not proof that the requested implementation exists.
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: task.id,
    data: { projectId: DEFAULT_PROJECT_ID, repositoryId },
  });

  const submittedBefore = runtime.submittedTasks.length;
  const repeated = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@Beta ${objective}` },
  });
  assert.equal(repeated.status, 201, JSON.stringify(repeated.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore + 1);
  const listed = await owner.request(`${base}/messages?limit=50`);
  assert.doesNotMatch(
    (listed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Already handled/u,
  );
});

test("reports receive current agent context instead of completed-work guesses", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "completed-work-report");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const first = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Alpha audit the session timeout guard" },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(task !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      explanation: "The earlier report is complete.",
    },
  });

  // An audit asks for a fresh report, even if an earlier audit happened to
  // use the same words. It must not be treated as an implementation that can
  // satisfy future requests by textual similarity.
  const submittedBefore = runtime.submittedTasks.length;
  const repeatedAudit = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Beta audit the session timeout guard" },
  });
  assert.equal(repeatedAudit.status, 201, JSON.stringify(repeatedAudit.data));
  assert.equal(runtime.submittedTasks.length, submittedBefore + 1);

  runtime.chatAnswer.text =
    "The earlier audit is complete, and a fresh audit is queued.";
  const submittedBeforeStatus = runtime.submittedTasks.length;
  const report = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Beta status report" },
  });
  assert.equal(report.status, 201, JSON.stringify(report.data));
  assert.equal(runtime.submittedTasks.length, submittedBeforeStatus);

  const listed = await owner.request(`${base}/messages?limit=50`);
  const response = (listed.data.messages as any[]).find(
    (message) => message.content === runtime.chatAnswer.text,
  );
  assert.ok(response !== undefined, JSON.stringify(listed.data.messages));
  assert.equal(response.referencedMessageId, report.data.message.id);
  const reportPrompt = [...runtime.chatPrompts]
    .reverse()
    .find((entry) => entry.prompt.includes("The message: @Beta status report"));
  assert.match(reportPrompt?.prompt ?? "", /finished and landed/u);
  assert.doesNotMatch(
    (listed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Already handled/u,
  );
});

test("duplicate recognition leaves unfinished, unsuccessful, opposed, uncertain, and thread work dispatchable", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org", callSign: "Alpha" },
    { provider: "openai", visibility: "org", callSign: "Beta" },
  ]);

  const scenarios: Array<{
    name: string;
    status: "submitted" | "integrated" | "failed" | "cancelled";
    first: string;
    second: string;
    inThread?: boolean;
  }> = [
    {
      name: "unfinished",
      status: "submitted",
      first: "implement the unfinished token refresh retry guard",
      second: "implement the unfinished token refresh retry guard",
    },
    {
      name: "failed",
      status: "failed",
      first: "implement the failed token refresh retry guard",
      second: "implement the failed token refresh retry guard",
    },
    {
      name: "cancelled",
      status: "cancelled",
      first: "implement the cancelled token refresh retry guard",
      second: "implement the cancelled token refresh retry guard",
    },
    {
      name: "opposed",
      status: "integrated",
      first: "add the opposed token refresh retry policy circuit breaker guard",
      second: "remove the opposed token refresh retry policy circuit breaker guard",
    },
    {
      name: "low-confidence",
      status: "integrated",
      first: "implement the uncertain cache retry policy",
      second: "implement retry dashboard metrics",
    },
    {
      name: "thread-follow-up",
      status: "integrated",
      first: "implement the threaded token refresh retry guard",
      second: "implement the threaded token refresh retry guard",
      inThread: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const repositoryId = await invitableRepository(
      owner,
      `completed-work-${String(index)}`,
    );
    await joinAllConnectedAgents(runtime, repositoryId);
    const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
    const first = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `@Alpha ${scenario.first}` },
    });
    assert.equal(first.status, 201, scenario.name);
    const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
    assert.ok(task !== undefined, scenario.name);
    if (scenario.status !== "submitted") {
      await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
      await runtime.store.completeSubmittedTask(task.id, scenario.status);
    }

    const submittedBefore = runtime.submittedTasks.length;
    const second = scenario.inThread === true
      ? await owner.request(
          `${base}/messages/${encodeURIComponent(first.data.message.id)}/replies`,
          { method: "POST", body: { content: `@Beta ${scenario.second}` } },
        )
      : await owner.request(`${base}/messages`, {
          method: "POST",
          body: { content: `@Beta ${scenario.second}` },
        });
    assert.equal(second.status, 201, scenario.name);
    if (scenario.inThread === true) {
      await waitFor(
        async () => runtime.submittedTasks.length === submittedBefore + 1,
        `${scenario.name} did not dispatch`,
      );
    }
    assert.equal(
      runtime.submittedTasks.length,
      submittedBefore + 1,
      `${scenario.name} was mistaken for completed work`,
    );
  }
});

test("an agent's own owner can always @mention it, personal or org-wide", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-self-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) kick off the release checklist" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1);
  const [selfTask] = runtime.submittedTasks;
  assert.ok(selfTask !== undefined);
  assert.equal(selfTask.actorId, bootstrapped.user.id);
  assert.equal(selfTask.vendor, "claude");

  const after = await owner.request(`${base}/messages`);
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
});

test("a human channel participant can be @mentioned without an agent refusal", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-human-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "human-mention@example.com");

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Colleague could you take a look at this?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0);
  const colleague = (await runtime.store.listUsers()).find(
    (user) => user.email === "human-mention@example.com",
  );
  assert.ok(colleague !== undefined);
  assert.deepEqual(posted.data.message.mentions, [
    { kind: "user", id: colleague.id, name: "Colleague" },
  ]);

  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(
    (after.data.messages as any[]).map((message) => message.content),
    ["@Colleague could you take a look at this?"],
  );
  assert.deepEqual((after.data.messages as any[])[0]?.mentions, [
    { kind: "user", id: colleague.id, name: "Colleague" },
  ]);
});


/** What the agents actually said, including replies inside task threads. */
test("a human mention suppresses auto-claim but not an explicit agent mention", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-human-agent-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "mixed-mention@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "@Colleague please update the release checklist" },
    })).status,
    201,
  );
  assert.equal(runtime.submittedTasks.length, 0);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: {
        content: "@Colleague please review while @Claude (Owner) updates the release checklist",
      },
    })).status,
    201,
  );
  assert.equal(runtime.submittedTasks.length, 1);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
  const after = await owner.request(`${base}/messages`);
  const mixed = (after.data.messages as any[]).find((message) =>
    message.content.includes("please review while"),
  );
  assert.deepEqual(
    mixed.mentions.map((mention: any) => mention.kind).sort(),
    ["agent", "user"],
  );
});

test("@everyone pings every person in the channel and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-everyone-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const colleague = await addColleague(runtime, "everyone-ping@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@everyone standup moved to ten" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // A ping is the whole of it. Mentioning one person has never submitted work
  // on their behalf, and saying it to the room at once cannot mean more.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));

  const listed = await owner.request(`${base}/messages`);
  const broadcast = (listed.data.messages as any[]).find((message) =>
    String(message.content).includes("standup moved"),
  );
  const pinged = (broadcast.mentions as any[])
    .filter((mention) => mention.kind === "user")
    .map((mention) => mention.id)
    .sort();
  assert.deepEqual(pinged, [bootstrapped.user.id, colleague.id].sort());
  // The room's agents are `@agents`. This word is for its people.
  assert.equal(
    (broadcast.mentions as any[]).some((mention) => mention.kind === "agent"),
    false,
  );
  // And a valid broadcast is never the unresolved-name error.
  assert.doesNotMatch(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Nobody here answers/u,
  );
});

test("@everyone still lets a named agent take work while /push stays direct", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-everyone-agent-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await addColleague(runtime, "everyone-and-agent@example.com");
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: {
        content: "@everyone heads up — @Claude (Owner) please update the release checklist",
      },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");

  // `/push` is a repository operation. Text after the command cannot turn it
  // into an agent task, even when that text is an agent-style broadcast.
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "/push @everyone" },
    })).status,
    201,
  );
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.pushCalls.length, 1);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Pushed canonical/u,
  );
});

test("a user outside the repository cannot be resolved as a channel ping", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-outsider-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await runtime.store.createUser({
    email: "outsider-mention@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Outsider please review this" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0);
  assert.deepEqual(posted.data.message.mentions, []);

  const after = await owner.request(`${base}/messages`);
  const coordinator = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent" || message.kind === "system",
  );
  assert.equal(coordinator.length, 1, JSON.stringify(after.data.messages));
  assert.match(coordinator[0].content, /Nobody here answers/u);
});

/**
 * Auto-claim (the no-@mention path in `dispatchChannelMentions` /
 * `maybeAutoClaimTask`): when a channel message reads as a task and exactly
 * one connected agent is a clear fit by role/name text, it is dispatched
 * automatically through the same `dispatchOneMention` an explicit @mention
 * uses. These tests cover the five scenarios called out in the brief: an
 * obvious single match, an ambiguous tie, plain chatter, a personal agent
 * that belongs to someone else, and an explicit @mention suppressing the
 * whole path even when an unmentioned agent would otherwise have matched.
 */
test("a clearly-scoped task message auto-claims to the one obviously-best agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-obvious");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const backend = await addColleague(runtime, "backend-obvious@example.com");
  const database = await addColleague(runtime, "database-obvious@example.com");
  runtime.chatConnections.set(backend.id, [{ provider: "openai", visibility: "org" }]);
  runtime.chatConnections.set(database.id, [{ provider: "google", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Rename each connected agent to reflect its lane, the same customization
  // `setChannelAgentOverride` already offers — see `scoreCandidate`'s doc
  // comment for why the auto-claim scorer matches against name text as well
  // as whatever role (if any) the channel has declared.
  const named = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { name: "Settings Page Layout Bot" },
  });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(
    (await backend.client.request(`${base}/agents/${backend.id}:openai`, {
      method: "POST",
      body: { name: "Auth Billing Backend Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await database.client.request(`${base}/agents/${database.id}:google`, {
      method: "POST",
      body: { name: "Database Schema Migrations Bot" },
    })).status,
    200,
  );

  // Which agent gets it is what this test is about; whether the message is
  // clear enough to act on outright is a different question, covered where
  // the classify prompt itself is tested.
  runtime.setTaskClassification("ACT");
  await autoClaim(owner, base, "please update the settings page layout");

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  assert.equal(task.actorId, bootstrapped.user.id);
  assert.equal(task.vendor, "claude");

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 1;
  }, "the auto-claimed task was not acknowledged");
  const after = await owner.request(`${base}/messages`);
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
});

test("an ambiguous task message is dispatched anyway, deterministically", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-ambiguous");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const first = await addColleague(runtime, "first-ambiguous@example.com");
  const second = await addColleague(runtime, "second-ambiguous@example.com");
  runtime.chatConnections.set(first.id, [{ provider: "openai", visibility: "org" }]);
  runtime.chatConnections.set(second.id, [{ provider: "google", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Same three content words in both names, in different order — a real
  // near-tie between two equally-plausible agents, not a contrived one.
  assert.equal(
    (await first.client.request(`${base}/agents/${first.id}:openai`, {
      method: "POST",
      body: { name: "Error Handling API Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await second.client.request(`${base}/agents/${second.id}:google`, {
      method: "POST",
      body: { name: "Api Error Handling Service" },
    })).status,
    200,
  );

  runtime.setTaskClassification("ACT");
  await autoClaim(owner, base, "can we clean up the error handling for the api");

  // A near-tie used to mean silence, on the reasoning that a coin flip
  // spends somebody's account. With two agents connected — the ordinary
  // case — near-ties are the norm, and the channel answered nothing that
  // was not @mentioned. Never answering is the worse failure, so the tie is
  // broken rather than refused.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  // Stable, not arbitrary: the same message must not land on a different
  // agent each time it is sent.
  await autoClaim(owner, base, "can we clean up the error handling for the api");
  assert.equal(runtime.submittedTasks.length, 2);
  assert.equal(
    runtime.submittedTasks[0]?.actorId,
    runtime.submittedTasks[1]?.actorId,
    "the same request must reach the same agent twice",
  );

  // Each chosen agent confirms its handoff in the request's thread.
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 2;
  }, "the auto-claimed tasks were not acknowledged");
  const after = await owner.request(`${base}/messages`);
  const agentMessages = agentSpeech(after.data.messages);
  assert.equal(agentMessages.length, 2, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages.every(
      (message) =>
        message.content === "I've taken this task and I'm working on it.",
    ),
    true,
  );
});

test("a plain non-task message auto-claims nothing", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-chatter");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "thanks!" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 0, JSON.stringify(systemMessages));
});

test("a best-fit agent personal to someone else is never auto-claimed for a stranger's message", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-personal");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // "Owner"'s connected Claude is personal, and its name would otherwise be
  // an obvious, unambiguous match for the message below.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Settings Page Layout Bot" },
    })).status,
    200,
  );

  const stranger = await addColleague(runtime, "stranger-personal@example.com");
  const posted = await stranger.client.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Nothing was submitted under anyone's account, and — a deliberate design
  // choice, see `maybeAutoClaimTask`'s doc comment — no system message
  // reveals that a personal agent would otherwise have been the pick. The
  // stranger sees only their own message; asking for this agent by name is
  // still available to them, and gets the usual "personal to Owner" refusal.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  assert.equal((after.data.messages as any[]).length, 1);
  const systemMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "system",
  );
  assert.equal(systemMessages.length, 0, JSON.stringify(systemMessages));
});

test("an explicit @mention suppresses auto-claim even when an unmentioned agent would otherwise match", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "auto-claim-vs-mention");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const backend = await addColleague(runtime, "backend-vs-mention@example.com");
  runtime.chatConnections.set(backend.id, [{ provider: "openai", visibility: "org" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Owner's own agent's name is the strongest textual match for the message
  // below, but it is not the one @mentioned.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Settings Page Layout Bot" },
    })).status,
    200,
  );
  assert.equal(
    (await backend.client.request(`${base}/agents/${backend.id}:openai`, {
      method: "POST",
      body: { name: "Backend Bot (Bella)" },
    })).status,
    200,
  );

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Backend Bot (Bella) please update the settings page layout",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Only the explicitly mentioned agent was dispatched — the whole point.
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  assert.equal(task.actorId, backend.id);
  assert.equal(task.vendor, "codex");
  assert.equal(
    task.context,
    undefined,
    "explicit mentions must not inherit ambient channel context",
  );

  const after = await owner.request(`${base}/messages`);
  const [acknowledgement] = agentSpeech(after.data.messages);
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(acknowledgement?.authorId, `${backend.id}:openai`);
});

/**
 * A question is not a task.
 *
 * "@Claude what are you working on" was being filed as a submitted task
 * named after the question, with a thread and a progress indicator attached
 * to work that would never exist — so the agent appeared to type forever.
 * Naming an agent is evidence the sender wants *something*; the question
 * mark is what says it is an answer rather than work.
 */
test("a question about repository files is answered in the channel, not turned into a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "question-not-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text =
    "The API gateway handles channel questions.\nANSWER_TASK: NONE";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) which file contains channel question routing?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // No task, and therefore no thread and nothing to keep an indicator alive.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages[0]?.content,
    "The API gateway handles channel questions.",
  );
  assert.doesNotMatch(String(agentMessages[0]?.content), /ANSWER_TASK/u);
  assert.deepEqual(agentMessages[0].replies ?? [], []);
  assert.equal(runtime.chatPrompts.at(-1)?.repositoryId, repositoryId);
});

/**
 * A deployment that executes nothing itself still picks up unaddressed work.
 *
 * The paid verdict — a provider turn per message in a populated channel — is
 * the operator's turn on a local-agents deployment, since there is no
 * credential of the asker's here. So it was refused outright and unaddressed
 * messages did nothing at all, which switched the feature off for exactly the
 * people whose agents run on their own accounts.
 *
 * The local classifier already embeds both prototype sets to answer "is this
 * confidently conversation". The mirror question costs nothing beyond the
 * embedding it just did, and only its confident half acts.
 */
test("unaddressed work is picked up locally, without spending a provider turn", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-autoclaim");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Conversation to the local model; work to its mirror. The uncertain middle
  // is everything neither answers true for.
  runtime.setLocalChatter((text) => text.startsWith("hi "));
  runtime.setLocalWork((text) => text.includes("retry loop"));
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "the retry loop keeps failing on timeouts" },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "an unaddressed message the local model read as work was never picked up",
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /retry loop/u,
  );
  // And the point of the whole exercise: no provider turn was spent deciding.
  assert.deepEqual(
    runtime.chatPrompts.slice(before),
    [],
    "the verdict must cost nothing on a deployment that executes nothing",
  );
});

/**
 * And the uncertain middle still does nothing, which is what the path did
 * before. This can only add dispatches the local model is sure about.
 */
test("a message the local model is unsure about is left alone", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-autoclaim-middle");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Neither confidently conversation nor confidently work.
  runtime.setLocalChatter(() => false);
  runtime.setLocalWork(() => false);
  const before = runtime.chatPrompts.length;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "wonder if that thing from yesterday matters" },
    })).status,
    201,
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtime.submittedTasks.length, 0, "the middle must not act");
  assert.deepEqual(runtime.chatPrompts.slice(before), []);
});

/**
 * A settings write must not empty the Agents tab.
 *
 * The browser replaces its whole provider list with whatever a settings write
 * answers. The GET route decorated its answer with `exists` — whether an agent
 * for this vendor exists at all, which stopped being the same question as
 * whether a credential is stored — and the settings route returned the
 * service's list raw. So any write, a rename or a model or a visibility
 * change, replaced the list with one whose `exists` was missing, and every
 * agent that runs on its owner's machine vanished from the tab until the next
 * reload. It read as though the setting had deleted them.
 */
test("changing a setting leaves every agent still on the tab", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const base = `/api/v1/chat/providers`;

  // An agent that exists as a record and has no credential — the ordinary
  // shape since local execution.
  assert.equal(
    (await owner.request(`${base}/anthropic/agent`, { method: "POST", body: {} }))
      .status,
    200,
  );
  const before = await owner.request(base);
  const listedBefore = (before.data.providers ?? []).filter(
    (entry: { exists?: boolean }) => entry.exists === true,
  );
  assert.equal(listedBefore.length, 1, JSON.stringify(before.data.providers));

  // The write the tab performs, and the list it replaces its state with.
  const written = await owner.request(`${base}/anthropic/settings`, {
    method: "POST",
    body: { visibility: "org" },
  });
  assert.equal(written.status, 200, JSON.stringify(written.data));
  const listedAfter = (written.data.providers ?? []).filter(
    (entry: { exists?: boolean }) => entry.exists === true,
  );
  assert.equal(
    listedAfter.length,
    1,
    "the settings response must carry the same agents the tab was drawn from",
  );

  // And the setting is readable afterwards, which is the other half: it lives
  // on the agent record when no credential can hold it, and something has to
  // read it back.
  const reloaded = await owner.request(base);
  const anthropic = (reloaded.data.providers ?? []).find(
    (entry: { id?: string }) => entry.id === "anthropic",
  );
  assert.equal(anthropic?.exists, true);
  assert.equal(
    anthropic?.recordVisibility,
    "org",
    "visibility set on a credential-less agent must survive a reload",
  );
  assert.equal(bootstrapped.user.id.length > 0, true);
});

/**
 * A screenshot must not stop a request being read as one.
 *
 * A pasted image arrives inside the message text as
 * `![shot.png](attachment:<32 hex>.png)`. The unaddressed-message reader is a
 * sentence-embedding model, so that blob is not neutral — it is thirty
 * characters of hex and punctuation pulling a short sentence away from
 * anything resembling a request. The same words were picked up without an
 * image and passed over with one, which is a strange rule for a product where
 * "here is a screenshot of the bug" is the most natural way to ask.
 */
test("an image in the message does not hide the request inside it", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "autoclaim-image");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The classifier is asked about the words. If the markup reached it, this
  // stub would see the hex and answer false.
  runtime.setLocalChatter(() => false);
  runtime.setLocalWork((text) => !/attachment:/u.test(text) && text.includes("unpin"));

  const shot = `${"a1b2c3d4".repeat(4)}.png`;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: {
        content: `there is no way to unpin a message, please add one\n![shot.png](attachment:${shot})`,
      },
    })).status,
    201,
  );

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "a request carrying a screenshot was never picked up",
  );
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /unpin/u);
});

/**
 * And a bare screenshot is still nothing to read: its markup is full of
 * letters, so the structural guard has to be asked about the words too.
 */
test("a message that is only a screenshot is not treated as a request", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "autoclaim-bare-image");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.setLocalChatter(() => false);
  runtime.setLocalWork(() => true);

  const shot = `${"b1c2d3e4".repeat(4)}.png`;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `![shot.png](attachment:${shot})` },
    })).status,
    201,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtime.submittedTasks.length, 0);
});

/**
 * A second unaddressed request goes to an agent that is free.
 *
 * Activity was keyed by the *configured agent id*, and by the person alone
 * when a deployment exposed no configured-agent list. That fallback made a
 * person's agents share one key: one of them working marked all of them busy,
 * so the "sender's own, free first" tier found nobody free, and the last
 * resort — the first candidate — handed the work straight back to the agent
 * already running. Somebody with three connected agents watched one take two
 * tasks while the other two sat idle.
 *
 * Keyed by vendor now, which needs no configuration to compute and is the
 * honest granularity: an agent is an account's CLI for one vendor.
 */
test("a second request goes to a free agent, not the one already working", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "autoclaim-spread");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  // Three agents, all this person's, on three vendors.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
    { provider: "cursor", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.setLocalChatter(() => false);
  runtime.setLocalWork(() => true);

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please add a way to unpin a message" },
    })).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length >= 1,
    "the first request was never picked up",
  );
  // The vendor, not `agentId`: a dispatch that names a vendor leaves the
  // configured-agent id to be resolved further down, so the fixture records
  // only the former — and asserting on the latter compares undefined with
  // undefined and fails whatever the code does.
  const first = runtime.submittedTasks[0]?.vendor;

  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "please add a way to reorder the sidebar" },
    })).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length >= 2,
    "the second request was never picked up",
  );

  assert.notEqual(
    runtime.submittedTasks[1]?.vendor,
    first,
    `the second request must not go to the agent already working: ${JSON.stringify(
      runtime.submittedTasks.map((task) => task.vendor),
    )}`,
  );
});

test("with local agents only, a channel question is still answered", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-only-question");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text =
    "The API gateway handles channel questions.\nANSWER_TASK: NONE";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) which file contains channel question routing?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const after = await owner.request(`${base}/messages`);
  const agentMessages = (after.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(agentMessages.length, 1, JSON.stringify(after.data.messages));
  assert.equal(
    agentMessages[0]?.content,
    "The API gateway handles channel questions.",
  );
});

/**
 * What the room is told when nothing is going to pick the work up.
 *
 * "I've taken this task and I'm working on it" is a sentence in the present
 * tense, and on a deployment that executes nothing itself it is false
 * whenever the owner's machine is not listening. The task is still filed and
 * a worker arriving later still runs it — nothing is lost — but a task
 * waiting on somebody who is asleep looked exactly like a task in progress,
 * and the only symptom was that it never finished.
 */
test("with local agents only and no machine listening, the room is told the truth", async (t) => {
  withLocalAgentsOnly(t);
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "local-only-waiting");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Work, not a question, so it takes the queue path and is acknowledged.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the login bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Filed either way: the queue is the durable thing, and a worker that
  // registers in ten minutes still picks this up.
  assert.equal(runtime.submittedTasks.length, 1);

  const after = await owner.request(`${base}/messages`);
  const [acknowledgement] = agentSpeech(after.data.messages);
  assert.match(
    String(acknowledgement?.content),
    /nothing is running it yet/u,
    JSON.stringify(after.data.messages),
  );
  assert.doesNotMatch(
    String(acknowledgement?.content),
    /I'm working on it/u,
  );
});

test("a question answer that proposes a repository change starts one scoped task and announces the handoff", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-proposes-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.channelAnswerText =
    "The retry routes currently have no cap, so malformed clients can loop forever.\n" +
    "ANSWER_TASK: Add a three-attempt cap to retry routes and cover it with API gateway tests";
  // The task-opening call is separate from the answer and should not repeat
  // the answer's private routing line.
  runtime.chatAnswer.text =
    "I will update the retry guard and verify its route tests.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) should retry routes cap malformed clients?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  // The request, out of the objective the worker is sent. Every task now
  // carries the answer-not-a-status-report directive behind what was asked,
  // which is coordinator plumbing rather than part of the scope this test is
  // about — and `requestFromObjective` is how every other reader takes it off.
  assert.equal(
    requestFromObjective(task?.objective ?? ""),
    "Add a three-attempt cap to retry routes and cover it with API gateway tests",
  );
  assert.equal(task?.conversationId, posted.data.message.id);
  assert.equal(runtime.runCalls.length, 1);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const root = (listed.data.messages as any[]).find(
      (message) => message.id === posted.data.message.id,
    );
    return root?.replies?.some(
      (reply: any) =>
        /update the retry guard|taken this task and.*working on it/iu.test(
          String(reply.content),
        ),
    ) === true;
  }, "the answer's task handoff was never announced");

  const listed = await owner.request(`${base}/messages`);
  const visibleAnswer = (listed.data.messages as any[]).find(
    (message) =>
      message.kind === "agent" &&
      message.content.startsWith("The retry routes currently"),
  );
  assert.equal(
    visibleAnswer?.content,
    "The retry routes currently have no cap, so malformed clients can loop forever.",
  );
  const allVisible = (listed.data.messages as any[])
    .flatMap((message) => [
      String(message.content),
      ...(message.replies ?? []).map((reply: any) => String(reply.content)),
    ])
    .join("\n");
  assert.doesNotMatch(allVisible, /ANSWER_TASK/u);
});

test("an agent's answer carries a reference to the message it answers", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "I am checking the current task queue.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) what are you working on?" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );

  assert.equal(answer?.content, runtime.chatAnswer.text);
  assert.equal(answer?.referencedMessageId, posted.data.message.id);
  assert.deepEqual(answer?.replies ?? [], []);
  assert.equal(runtime.submittedTasks.length, 0);
});

test("a request that names no verb this list knows is still work when an agent is named", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "mention-is-intent");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // "kick off" is in no verb list here. Naming the agent is the intent, and
  // answering this with chat instead of doing it would be the worse failure.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) kick off the release checklist" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));

  const after = await owner.request(`${base}/messages`);
  const taskRoot = (after.data.messages as any[]).find(
    (message) => message.id === posted.data.message.id,
  );
  // The request remains the root and the agent confirms the handoff beneath
  // it before the run has anything task-specific to narrate.
  const replies = taskRoot?.replies ?? [];
  const [acknowledgement] = replies.filter(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.equal(taskRoot?.kind, "user");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(taskRoot?.taskId, task?.id);
  // Whenever something is written here, it is named after the work rather
  // than after an id.
  assert.ok(
    !replies.some((reply: any) => /task_[0-9a-f-]{8}/u.test(String(reply.content))),
    "a task id is not a name anybody can read",
  );
});

/**
 * The opening line is a summary, not an echo.
 *
 * Reading somebody's own sentence back to them says nothing about whether it
 * was understood, and a request usually arrives with context in front of it —
 * "this is a greenfield project… can you get started" is a request to get
 * started, and the first clause is background.
 */
test("a polite request is work unless it actually asks whether", () => {
  // "can you …" opens an instruction as often as a question. The verb list
  // cannot settle it — the verbs people use for interface work (condense,
  // tailor, tidy) are open-ended — so the question mark does: asking whether
  // something is possible gets one, telling an agent what to do does not.
  for (const request of [
    "@Cronus can you take reference from slack to vertically condense the top bar",
    "could you tidy the settings page so it reads like Linear's",
    "please can you reword the empty state on the runs screen",
    "Would you tailor the top bar for the chat experience",
  ]) {
    assert.equal(readsAsQuestion(request), false, request);
  }
  for (const question of [
    "can you see the payments repo?",
    "could you explain how the queue works?",
    "what are you working on",
    "is the release checklist done",
    "@Cronus summarise the codebase",
  ]) {
    assert.equal(readsAsQuestion(question), true, question);
  }
  // A real task verb still wins with or without the question mark.
  assert.equal(readsAsQuestion("can we make a chess game?"), false);
});

test("an opening line summarises the request rather than repeating it", () => {
  assert.equal(
    summariseObjective("please create the initial skeleton for a browser chess game"),
    "create the initial skeleton for a browser chess game",
  );
  assert.equal(
    summariseObjective("can we make a simple chess game with a browser UI"),
    "make a simple chess game with a browser UI",
  );
  // Background first, ask second: the ask is what gets summarised.
  assert.equal(
    summariseObjective(
      "this is a greenfield project, the end goal is a chess engine browser based. can you get started on the skeleton",
    ),
    "get started on the skeleton",
  );
  // Nothing to strip is left alone rather than mangled.
  assert.equal(
    summariseObjective("kick off the release checklist"),
    "kick off the release checklist",
  );
  // Long requests are cut on a word boundary, never mid-word.
  const long = summariseObjective(
    "rewrite the entire authentication subsystem including session handling, token rotation, and the password reset flow end to end",
  );
  assert.ok(long.length <= 91, long);
  assert.ok(long.endsWith("…"), long);
  assert.ok(!/\w…$/u.test(long.replace(/\s\S*…$/u, "")), long);
});

test("thread titles use one short clean line or a bounded fallback", () => {
  assert.equal(
    normaliseThreadTitle(
      '"Title: Token refresh reliability."\nThis line is explanation.',
      "fix token refresh",
    ),
    "Token refresh reliability",
  );
  assert.equal(
    normaliseThreadTitle(
      "This model response contains far too many words to be a thread title",
      "repair token rotation and refresh retry handling across the application",
    ),
    "repair token rotation and refresh retry",
  );
  assert.equal(
    normaliseThreadTitle("\n\n", "repair token refresh behavior"),
    "repair token refresh behavior",
  );
  assert.equal(normaliseThreadTitle("Task:", ""), "Software task");
});

test("the local thread-title writer receives only the visible request", async () => {
  let received = "";
  const title = await summariseThreadTitle(
    "please repair token refresh behavior",
    async (prompt) => {
      received = prompt;
      return "- Refresh token reliability";
    },
  );
  assert.equal(title, "Refresh token reliability");
  assert.match(received, /Request:\nplease repair token refresh behavior$/u);

  const fallback = await summariseThreadTitle(
    "please repair token refresh behavior",
    async () => {
      throw new Error("local model unavailable");
    },
  );
  assert.equal(fallback, "repair token refresh behavior");
});

/**
 * A request to the room, sharing no vocabulary with any agent's role.
 *
 * "can someone start building general infrastructure for a chess engine" is
 * unmistakably a task and was met with silence, because scoring required a
 * candidate to share a word with the message before anybody could take it.
 * Relevance decides who; it must not decide whether.
 */
test("an unaddressed task is taken even when it matches no agent's role", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unmatched-but-taken");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  await autoClaim(
    owner,
    base,
    "can someone start building general infrastructure for a chess engine",
  );
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.submittedTasks[0]?.actorId, bootstrapped.user.id);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return agentSpeech(listed.data.messages).length === 1;
  }, "the unmatched auto-claimed task was not acknowledged");
  const after = await owner.request(`${base}/messages`);
  assert.equal(
    agentSpeech(after.data.messages)[0]?.content,
    "I've taken this task and I'm working on it.",
  );
});

test("recent activity is one agent's, not its owner's whole roster", async (t) => {
  // Every task a channel dispatches is submitted under the *agent's owner*,
  // deliberately, so work somebody else's agent takes never spends the
  // sender's account. Grouping the activity signal on that alone merged every
  // agent one person owns into a single history — connect an org-wide Claude
  // and an org-wide Codex and both score identically, with the signal unable
  // to say which of them did what. With org agents that is the ordinary case.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "per-agent-activity");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Two agents, one owner — the case the grouping key could not tell apart.
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Both names share the one word the message will match, so neither leads on
  // role and the activity signal is what decides. The idle one is named
  // longer on purpose: candidates sort by name length, so it is first in line
  // and would take the work on the tie that owner-grouping produces.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Deploy Alpha" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/${ownerId}:openai`, {
      method: "POST",
      body: { name: "Deploy Beta Nightly Runner" },
    })).status,
    200,
  );

  // History under the Claude agent alone. `test-agent-claude` is what the
  // fixture's `submitTask` resolves the claude vendor to, and what
  // `listAgents` reports for that adapter — the join the grouping makes.
  for (const objective of [
    "migrate the postgres schema for sessions",
    "fix the postgres migration ordering",
  ]) {
    await runtime.store.submitTask({
      repositoryId,
      objective,
      agentId: "test-agent-claude",
      validationCommands: [],
      submittedBy: ownerId,
    });
  }

  runtime.setTaskClassification("ACT");
  await autoClaim(owner, base, "please deploy the postgres migration");

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  // The agent that has actually been doing postgres migrations here, not the
  // one that happens to share its owner.
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

test("with no configured agents to join on, activity falls back to its owner", async (t) => {
  // `listAgents` is optional on `ApiOperations`. Where it is absent there is
  // nothing to key a per-agent history on, and the scorer must still work —
  // grouping by owner, which is wrong only in the way the test above
  // describes and no worse than before.
  const runtime = await startRuntime(t, { withoutListAgents: true });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "owner-fallback");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Deploy Alpha" },
    })).status,
    200,
  );
  await runtime.store.submitTask({
    repositoryId,
    objective: "migrate the postgres schema for sessions",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  runtime.setTaskClassification("ACT");
  await autoClaim(owner, base, "please deploy the postgres migration");
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

/**
 * A task that ends at integration records `explanation` and a `status`, not
 * `error` — so reading only `error` turned the most common ending into a bare
 * "I could not finish this." with nothing a reader could act on. Observed in a
 * real thread: a failed task, no reason given, and the question that followed
 * it went unanswered.
 */
test("a task that reported rather than changed reads as an ending, not a failure", () => {
  // "Changed no files" is failure for "fix the retry loop" and success for
  // "audit the codebase". The channel used to say the second was the first.
  assert.equal(
    narrateTaskEvent("task_reported", {
      explanation: "No logic errors in the diff; two naming nits, both safe.",
    }),
    "No logic errors in the diff; two naming nits, both safe.",
  );
  // The agent's own words are the deliverable, but their absence is not a
  // reason to say nothing.
  assert.equal(
    narrateTaskEvent("task_reported", {}),
    "Finished without needing to change anything.",
  );
});
