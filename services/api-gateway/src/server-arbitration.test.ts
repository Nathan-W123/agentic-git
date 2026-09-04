/** The gateway over HTTP: direct messages, stats, arbitration and the auditor. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  agentIdentity,
  looksLikeTaskRequest,
  reportedFreshTokens,
  requestFromObjective,
  textOverlap,
  withRoleContext,
} from "./server.js";
import {
  PASSWORD,
  TestClient,
  type TestRuntime,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  joinRepository,
  repositoryWithAuditor,
  roomWithTwoAgents,
  startRuntime,
  waitFor,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("an agent is told its own name, so a mention of it is not a product", async (t) => {
  // Asked "@Apollo can you audit the codebase", Codex — which *is* Apollo —
  // replied that "the Apollo integration isn't installed" and that it had
  // requested installation. With no other context, a call sign is a product.
  const identity = agentIdentity({
    name: "Apollo",
    role: "auditor",
    userName: "Nathan",
  });
  assert.match(identity, /You are "Apollo"/u);
  assert.match(identity, /@Apollo" is addressed to you/u);
  assert.match(identity, /not a reference to some product or integration/u);
  assert.match(identity, /You belong to Nathan/u);
  assert.match(identity, /Your role in this channel is: auditor/u);

  // An unlabelled agent still gets a name, just no role sentence.
  const bare = agentIdentity({ name: "Icarus", role: "  ", userName: "Sam" });
  assert.match(bare, /You are "Icarus"/u);
  assert.doesNotMatch(bare, /Your role in this channel/u);
});

test("a direct message reaches its recipient and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  await invitableRepository(owner, "dm-shared");
  const organizationId = (await owner.request("/api/v1/organizations")).data
    .organizations[0].id as string;

  // Two more people in the same organization: one to write to, one who must
  // not be able to read what was written.
  const people: Record<string, string> = {};
  for (const name of ["bystander", "friend"]) {
    const user = await runtime.store.createUser({
      email: `${name}@example.com`,
      displayName: name,
      passwordDigest: await hashPassword(PASSWORD),
    });
    await runtime.store.saveMembership({
      organizationId,
      userId: user.id,
      role: "developer",
    });
    people[name] = user.id;
  }
  const sign = async (name: string): Promise<TestClient> => {
    const client = new TestClient(runtime.origin);
    const login = await client.request("/api/v1/auth/login", {
      method: "POST",
      body: { email: `${name}@example.com`, password: PASSWORD },
    });
    assert.equal(login.status, 200);
    return client;
  };
  const friend = await sign("friend");
  const bystander = await sign("bystander");
  const friendId = people["friend"] ?? "";
  const bystanderId = people["bystander"] ?? "";

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
    { method: "POST", body: { content: "  Just between us.  " } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.message.content, "Just between us.");

  const reply = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}`,
    {
      method: "POST",
      body: {
        content: "I agree.",
        referencedMessageId: sent.data.message.id,
      },
    },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.message.referencedMessageId, sent.data.message.id);

  // The conversation reads the same from either side.
  for (const [client, other] of [
    [owner, friendId],
    [friend, session.user.id],
  ] as const) {
    const thread = await client.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${other}`,
    );
    assert.equal(thread.status, 200);
    assert.deepEqual(
      thread.data.messages.map((message: { content: string }) => message.content),
      ["Just between us.", "I agree."],
    );
  }

  // The bystander is in the same organization and can reach the route, but
  // asking for either participant returns their own (empty) conversation
  // rather than anyone else's.
  for (const other of [friendId, session.user.id]) {
    const peek = await bystander.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${other}`,
    );
    assert.equal(peek.status, 200);
    assert.deepEqual(peek.data.messages, []);
  }
  const unrelatedReference = await bystander.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
    {
      method: "POST",
      body: {
        content: "Can I join in?",
        referencedMessageId: sent.data.message.id,
      },
    },
  );
  assert.equal(unrelatedReference.status, 400);

  // Unread is counted for each recipient only, and clears when they read it.
  const inbox = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.conversations[0].unread, 1);
  assert.equal(
    (await owner.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`))
      .data.conversations[0].unread,
    1,
  );
  // The roster names everyone else, and never the person asking.
  assert.deepEqual(
    (inbox.data.people as { id: string }[]).map((person) => person.id).sort(),
    [session.user.id, bystanderId].sort(),
  );

  const read = await friend.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/read`,
    { method: "POST" },
  );
  assert.equal(read.data.marked, 1);
  assert.equal(
    (await friend.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`))
      .data.conversations[0].unread,
    0,
  );

  // Writing to yourself, to a stranger, or saying nothing are all refused.
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}`,
        { method: "POST", body: { content: "hello me" } },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/user_nobody`,
        { method: "POST", body: { content: "hello?" } },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await owner.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${friendId}`,
        { method: "POST", body: { content: "   " } },
      )
    ).status,
    400,
  );

  // A conversation may remain in storage after its other participant leaves
  // the project, but it is no longer a destination the viewer can open. The
  // inbox must drop it along with the departed profile; otherwise the browser
  // can only label the row with its internal `user_…` id.
  await runtime.store.removeMembership(organizationId, friendId);
  const afterFriendLeft = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(afterFriendLeft.status, 200);
  assert.equal(
    (afterFriendLeft.data.conversations as { userId: string }[]).some(
      (conversation) => conversation.userId === friendId,
    ),
    false,
  );
  assert.equal(
    (afterFriendLeft.data.people as { id: string }[]).some(
      (person) => person.id === friendId,
    ),
    false,
  );
});

test("direct messages require a shared repository channel", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const sharedRepository = await invitableRepository(owner, "dm-room-shared");
  const isolatedRepository = await invitableRepository(
    owner,
    "dm-room-isolated",
  );
  const first = await joinRepository(
    runtime,
    owner,
    "dm-first@example.com",
    sharedRepository,
  );
  const shared = await joinRepository(
    runtime,
    owner,
    "dm-shared@example.com",
    sharedRepository,
  );
  const isolated = await joinRepository(
    runtime,
    owner,
    "dm-isolated@example.com",
    isolatedRepository,
  );
  const sharedId = (await shared.request("/api/v1/auth/me")).data.user.id;
  const isolatedId = (await isolated.request("/api/v1/auth/me")).data.user.id;

  const inbox = await first.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages`,
  );
  assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
  const reachable = new Set(
    (inbox.data.people as { id: string }[]).map((person) => person.id),
  );
  assert.equal(reachable.has(sharedId), true);
  assert.equal(reachable.has(isolatedId), false);

  const sent = await first.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${sharedId}`,
    { method: "POST", body: { content: "We share this room." } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(
    (
      await first.request(
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${sharedId}`,
      )
    ).status,
    200,
  );

  for (const method of ["GET", "POST"] as const) {
    const refused = await first.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${isolatedId}`,
      method === "POST"
        ? { method, body: { content: "We do not share a room." } }
        : { method },
    );
    assert.equal(refused.status, 404, JSON.stringify(refused.data));
  }
});

test("channel stats count every root and reply, past the read page", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "counted-room");

  // Past the 200-row page the channel read is capped at. The stats line used
  // to be the length of that page, so a room this size reported "200+" — a
  // figure that stops being true the moment the room gets busy.
  for (let index = 0; index < 205; index += 1) {
    const root = await runtime.store.appendChannelMessage({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      authorId: ownerId,
      content: `Line ${index}`,
    });
    if (index % 5 === 0) {
      await runtime.store.addChannelReply({
        repositoryId,
        messageId: root.id,
        authorId: ownerId,
        content: `Reply to ${index}`,
      });
    }
  }

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.messages, 205);
  assert.equal(response.data.replies, 41);
  // Nothing is approximated any more, so there is no "and more" flag left.
  assert.equal(response.data.capped, undefined);
});

test("channel stats exclude cached context from the token activity total", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "token-stats");

  await runtime.store.recordTokenUsage({
    usageKey: "fresh:planning",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_fresh",
    agentId: "codex",
    phase: "planning",
    inputTokens: 10_000,
    outputTokens: 500,
    freshTokens: 2_500,
    totalTokens: 25_000,
    recordedAt: "2026-08-20T00:00:00.000Z",
  });
  // Historical rows have no explicit cache-adjusted value. Their output is
  // still certainly fresh, so it contributes as a lower bound rather than
  // falling back to the much larger billed total.
  await runtime.store.recordTokenUsage({
    usageKey: "legacy:execution",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_legacy",
    agentId: "claude",
    phase: "execution",
    inputTokens: 90_000,
    outputTokens: 700,
    totalTokens: 90_700,
    recordedAt: "2026-08-20T00:01:00.000Z",
  });

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.tokens, 3_200);
  assert.equal(response.data.tokensIncomplete, true);
});

test("channel stats keep an inconsistent token report inside its own bounds", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "token-bounds");

  // A fresh figure larger than what was billed is impossible, and letting it
  // through is how the line reads high; the billed total is the ceiling.
  await runtime.store.recordTokenUsage({
    usageKey: "over:planning",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_over",
    agentId: "codex",
    phase: "planning",
    inputTokens: 4_000,
    outputTokens: 100,
    freshTokens: 9_000,
    totalTokens: 5_000,
    recordedAt: "2026-08-20T00:00:00.000Z",
  });
  // Output is always new work, so it is the floor even when the reported
  // fresh figure somehow lands beneath it.
  await runtime.store.recordTokenUsage({
    usageKey: "under:execution",
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: "task_under",
    agentId: "claude",
    phase: "execution",
    inputTokens: 30_000,
    outputTokens: 400,
    freshTokens: 50,
    totalTokens: 31_000,
    recordedAt: "2026-08-20T00:01:00.000Z",
  });

  const response = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.tokens, 5_400);
  // Both rows carry a cache split, so nothing here is a lower bound.
  assert.equal(response.data.tokensIncomplete, false);
});

test("a channel route will not read a repository from another project", async (t) => {
  // The last two `/channel/*` routes that authorized the repository without
  // checking it belongs to the project in the path. An organization role
  // reaches every repository the organization has, so `authorizeRepository`
  // alone lets any member name any repository under any project id — and
  // `channel/stats` answers with that room's message counts and an
  // afternoon's token spend.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "channel-tenancy");
  // A second project in the same organization, so the caller is genuinely
  // authorized and only the pairing is wrong.
  const elsewhere = await runtime.store.createProject({
    organizationId: DEFAULT_ORGANIZATION_ID,
    slug: "elsewhere",
    name: "Elsewhere",
  });

  const stats = await owner.request(
    `/api/v1/projects/${elsewhere.id}/repositories/${repo}/channel/stats`,
  );
  assert.equal(stats.status, 404, JSON.stringify(stats.data));

  const simplify = await owner.request(
    `/api/v1/projects/${elsewhere.id}/repositories/${repo}/channel/replies/reply_1/simplify`,
    { method: "POST", body: { text: "something long" } },
  );
  assert.equal(simplify.status, 404, JSON.stringify(simplify.data));

  // The same calls under the project it really belongs to still work, or the
  // guard would be a regression rather than a fix.
  const paired = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/stats`,
  );
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
});

test("a stored objective reads back as the request, not the coordinator's script", () => {
  // What a worker is sent is the request wrapped in instructions: a role
  // preamble in front, and behind it whichever directives applied — the
  // answer-not-a-status-report one on every task, and `/simple` or `/dnc`
  // when asked for. Six places read that string back as if it were the
  // request. Some show it to people; some compare it, and those are the ones
  // that broke, because boilerplate every objective shares drags every
  // similarity score toward each other and away from the words that differ.
  const request = "rework the retry policy and its tests";
  const sent = withRoleContext(
    "senior engineer",
    [
      request,
      "Your final message is the answer, not a status report. If you " +
        "delegated to a subagent, wait for its result before finishing — " +
        "never end a turn saying a search is running or that you will " +
        "report back. Do not state a conclusion while work you started is " +
        "still outstanding. If you cannot answer, say what you checked and " +
        "what would settle it.",
      "Keep every reply as short and simple as it can possibly be: the " +
        "fewest, plainest words that still say it, one short sentence when " +
        "one is enough — no preamble, no restating the request, nothing " +
        "extra.",
    ].join("\n\n"),
  );
  assert.equal(requestFromObjective(sent), request);

  // The measurement: against a merge bar of 0.42, two identical requests
  // scored 0.11 while the directives were in the comparison.
  assert.ok(
    textOverlap(request, sent) < 0.42,
    "the whole objective is what dropped the score under the bar",
  );
  assert.ok(textOverlap(request, requestFromObjective(sent)) > 0.9);

  // A request that quotes a directive keeps it: the paragraphs are matched
  // whole, not searched for.
  const quoting = `${request}\n\nKeep every reply short.`;
  assert.equal(requestFromObjective(quoting), quoting);

  // And an objective that is nothing but a directive still reads back as
  // something, rather than as an empty string a caller would render blank.
  assert.notEqual(
    requestFromObjective(
      "Keep every reply as short and simple as it can possibly be: the " +
        "fewest, plainest words that still say it, one short sentence when " +
        "one is enough — no preamble, no restating the request, nothing " +
        "extra.",
    ),
    "",
  );
});

test("a worker report without a fresh figure still separates cached context", () => {
  // Rollout reality: a worker built before the fresh field existed reports
  // the split and nothing else. Its total exceeding the two sides means the
  // cache is accounted for separately, so input plus output is new work.
  assert.equal(reportedFreshTokens(undefined, 2_000, 500, 25_000), 2_500);
  // A total that is exactly the two sides is the ambiguous case — cache
  // folded into the input reads identically — so no figure is claimed and
  // the row counts as a lower bound instead.
  assert.equal(reportedFreshTokens(undefined, 2_000, 500, 2_500), undefined);
  // An explicit figure is taken as given, unless it exceeds what was billed.
  assert.equal(reportedFreshTokens(1_200, 2_000, 500, 25_000), 1_200);
  assert.equal(reportedFreshTokens(30_000, 2_000, 500, 25_000), undefined);
  assert.equal(
    reportedFreshTokens(undefined, undefined, 500, 25_000),
    undefined,
  );
});

test("asking an agent to audit dispatches work instead of discussing it", async (t) => {
  // `audit` was not among the task verbs, so "can you audit the codebase" was
  // classified as a question and answered by a model with no repository in
  // front of it — which produced a chat about auditing rather than an audit.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "examined");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  const agent = roster.data.agents[0];
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;
  assert.notEqual(agent, undefined);

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} can you audit the codebase` } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking for an audit never became work",
  );
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /audit/iu);
});

test("a question in the channel carries the agent's own work with it", async (t) => {
  // "@Apollo what are you working on" was answered with the question echoed
  // back, because the prompt held the question and nothing else. The store
  // knew the answer the whole time.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "Still on the retry loop.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  // Give the agent a task to be working on.
  await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "Fix the retry loop in worker.ts",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: ownerId,
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} what are you working on?` } },
  );

  await waitFor(
    async () => runtime.chatPrompts.length > 0,
    "the question never reached the agent",
  );
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  // Who it is, and what it is doing — the two things the bare prompt lacked.
  assert.match(prompt, new RegExp(`You are "${mention.replace(/[()]/gu, "\\$&")}"`, "u"));
  assert.match(prompt, /Fix the retry loop in worker\.ts/u);
  assert.match(prompt, /Your tasks in this repository/u);
  // Repository-backed questions can inspect files without claiming a change.
  assert.match(prompt, /read-only checkout/u);
  assert.match(prompt, /Inspect it whenever the answer depends on the code/u);
});

test("a run that cannot start says so, instead of an hour of silence", async (t) => {
  // The channel showed a working indicator and then nothing. The run rejected
  // before it wrote a single audit event, so the progress watcher had nothing
  // to follow and held its opening line until the one-hour watchdog gave up —
  // and the reason, which the failing call had in hand, went to stderr where
  // nobody reading the channel can see it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "cannotstart");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  runtime.runFailure.reason =
    "Repository id cannotstart is already mapped to a different canonical repository";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("I could not start this"),
      ),
    );
  }, "the channel never said why the run did not start");

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const said = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .join("\n");
  // The actual reason, not a generic apology — it is the only thing that
  // tells the reader what to do next.
  assert.match(said, /already mapped to a different canonical repository/u);
});

test("a planning failure names the cause, not just the wrapper", async (t) => {
  // What a wave failing during planning actually rejects with. Its own message
  // says only that something failed; which task and why are in `errors`, and
  // reading `.message` dropped them — so the channel reported the shape of the
  // failure and never its cause, and the one place the answer existed was a
  // log nobody reading the thread can open.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "aggregatecause");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  runtime.runFailure.error = new AggregateError(
    [new Error("codex exited before writing a plan")],
    "One or more tasks failed during planning",
  );
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} build the render half` } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("I could not start this"),
      ),
    );
  }, "the channel never said the run did not start");

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const said = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .join("\n");
  // Both halves: the wrapper still orients the reader, and the cause is what
  // they can actually act on.
  assert.match(said, /One or more tasks failed during planning/u);
  assert.match(said, /codex exited before writing a plan/u);
});

test("a finished thread carries its summary and its line counts", async (t) => {
  // Two failures with one cause between them, both about a thread that has
  // finished. The ending is the agent's own account of the work now, and
  // nothing a model writes begins "Done —" — so the browser, which decided
  // what an ending was by matching that text, filed the summary inside the
  // collapsed thinking block and left the typing dots running. And the counts
  // that go beside the file list were emitted by one executor and not the
  // other, so whether a thread showed "+12 −3" or bare paths came down to
  // which code path had run the task.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "threadending");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} raise the retry ceiling in worker.ts` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined, "the dispatch stored no task");

  // The run as the log records it, in order: an edit in flight, the collected
  // changeset, and the promotion that ends it. Written in one go so a single
  // poll of the watcher consumes all three.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId: task.id,
    data: {
      files: [
        { path: "worker.ts", status: "modified" },
        { path: "worker.test.ts", status: "modified" },
      ],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "changeset_collected",
    taskId: task.id,
    data: {
      changeSetId: "cs_1",
      // Two files on purpose: a single-file run with a one-line account now
      // ends as a channel `outcome` line rather than a thread — a room is for
      // work with a story. This test is about the thread-shaped ending, so
      // its run does thread-shaped work.
      files: ["worker.ts", "worker.test.ts"],
      changedFiles: [
        { path: "worker.ts", status: "modified", added: 12, removed: 3 },
        { path: "worker.test.ts", status: "modified", added: 6, removed: 1 },
      ],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      files: ["worker.ts"],
      agentExplanation: "Raised the retry ceiling to five.",
    },
  });

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) =>
        message.replies.some((reply) => reply.kind === "outcome"),
      );
    },
    "the run's ending was never marked as one",
    8_000,
  );

  const listed = await owner.request(`${base}/messages`);
  const thread = listed.data.messages.find(
    (message: any) => (message.replies ?? []).length > 0,
  );
  const ending = (thread?.replies ?? []).find(
    (reply: any) => reply.kind === "outcome",
  );
  // The agent's own words, not the sentence that was true of every task this
  // system has ever finished — and marked, so the browser does not have to
  // recognise those words to know the thread is done.
  assert.match(String(ending?.content), /Raised the retry ceiling to five\./u);
  assert.doesNotMatch(String(ending?.content), /the change is in canonical/u);
  // Everything before it is the run narrating itself, and stays marked as
  // such: if the ending were `progress` too the thread would have no visible
  // conclusion at all.
  const kinds = (thread?.replies ?? []).map((reply: any) => reply.kind);
  assert.equal(kinds.filter((kind: string) => kind === "outcome").length, 1);
  assert.ok(
    kinds.includes("progress"),
    `the narration lost its progress mark: ${JSON.stringify(kinds)}`,
  );

  // And the file summary survives the round trip with its counts. The final
  // `changeset_collected` is what carries them; the live workspace poll before
  // it cannot count lines, and must not be what the thread is left showing.
  assert.deepEqual(thread?.changedFiles, [
    { path: "worker.ts", status: "modified", added: 12, removed: 3 },
    { path: "worker.test.ts", status: "modified", added: 6, removed: 1 },
  ]);
});

test("a quick task keeps its outcome inline after acknowledging the handoff", async (t) => {
  // The counterpart of the test above, and the one that was missing while the
  // feature it covers sat inert. Holding the ceremony is only half of it: the
  // held set has to name *every* line that is true of all runs, and
  // `plan_received` — the first thing narrated after the opening, traced by
  // every planned turn — was not in it. So the first poll flushed the held
  // opening into a thread and marked the run threaded before any ending
  // existed, and "change this 1 to a 2" got the room, the title and the
  // running commentary the whole mechanism was written to prevent.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "quicktask");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} change the retry count to 2` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined, "the dispatch stored no task");

  // The whole life of an ordinary one-file run, in the order the coordinator
  // traces it. Every one of these is true of every run that has ever
  // succeeded, so not one of them is a reason to open a room.
  for (const event of [
    { type: "plan_received" as const, data: { expectedFiles: ["retry.ts"] } },
    { type: "plan_admitted" as const, data: { status: "approved" } },
    { type: "task_started" as const, data: {} },
    {
      type: "changeset_collected" as const,
      data: {
        changeSetId: "cs_quick",
        files: ["retry.ts"],
        changedFiles: [
          { path: "retry.ts", status: "modified", added: 1, removed: 1 },
        ],
      },
    },
    {
      type: "canonical_promoted" as const,
      data: { files: ["retry.ts"], agentExplanation: "Changed the retry count to 2." },
    },
  ]) {
    await runtime.store.appendAudit(undefined, {
      type: event.type,
      taskId: task.id,
      data: event.data,
    });
  }

  await waitFor(
    async () => {
      const messages = await runtime.store.listChannelMessages(repo, ownerId);
      return messages.some((message) => message.kind === "outcome");
    },
    "the run never produced an ending",
    8_000,
  );

  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  // The ending stays flat in the room.
  const ending = messages.find((message) => message.kind === "outcome");
  assert.match(
    String(ending?.content),
    /Changed the retry count to 2\./u,
    `the ending did not carry the agent's own words: ${JSON.stringify(ending)}`,
  );
  // The request has only the immediate handoff reply; routine run ceremony is
  // still held back and the concise outcome stays in the room.
  const root = messages.find(
    (message) => message.kind === "user" && message.taskId === task.id,
  );
  // Two immediate lines, and nothing from the run.
  //
  // The handoff reply is posted as a canned sentence and then contextualised
  // in place by the agent's own opening — `chatAnswer.text` here — so its
  // final wording is the agent's, not the placeholder's. The `Task:` line is
  // the thread's name, which every surface reads a title off. Neither is run
  // ceremony, which is what this test is about: no `plan_received`, no
  // `plan_admitted`, no `task_started`, no changeset narration. Comparing the
  // whole list is what keeps that true — a ceremony line leaking in fails
  // here.
  assert.deepEqual(
    (root?.replies ?? []).map((reply) => ({
      kind: reply.kind,
      content: reply.content,
    })),
    [
      { kind: "agent", content: "On it." },
      { kind: "progress", content: "Task: change the retry count to 2" },
    ],
    JSON.stringify(root),
  );
});

/**
 * Every arbitration line currently standing, wherever it is standing.
 *
 * A hold is the held agent's own reply inside its thread now, so a test that
 * read only the room's roots would pass just as well on a deployment that had
 * stopped saying anything at all. Both places are collected, and each line
 * says which it came from, because proving the room-level fallback is *not*
 * being used is half of what these tests are for.
 *
 * Thread lines are taken by kind as well as by marker: the run's own narration
 * of the same admission opens with the same symbol and is `progress`, and it
 * is not the notice — it is what this suppresses.
 */
async function arbitrationLines(
  runtime: TestRuntime,
  repositoryId: string,
  viewerId: string,
): Promise<
  { authorId: string; content: string; inThread: boolean }[]
> {
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    viewerId,
  );
  return messages.flatMap((message) => [
    ...(message.replies ?? [])
      .filter(
        (reply) => reply.kind === "agent" && reply.content.startsWith("⚖️"),
      )
      .map((reply) => ({
        authorId: reply.authorId,
        content: reply.content,
        inThread: true,
      })),
    ...(message.authorId === "coordinator"
      ? [
          {
            authorId: message.authorId,
            content: message.content,
            inThread: false,
          },
        ]
      : []),
  ]);
}

/** Every reply in the thread one task is narrating into. */
async function threadRepliesFor(
  runtime: TestRuntime,
  repositoryId: string,
  viewerId: string,
  taskId: string,
): Promise<{ kind: string; authorId: string; content: string }[]> {
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    viewerId,
  );
  const root = messages.find((message) => message.taskId === taskId);
  return (root?.replies ?? []).map((reply) => ({
    kind: String(reply.kind),
    authorId: reply.authorId,
    content: reply.content,
  }));
}

/**
 * Puts one dispatched task in the room, which is what starts the fast pump.
 *
 * `announceArbitration` rides on `pumpChannelProgress`, and that timer only
 * exists while some task is being watched — so a conflict test needs a real
 * mention dispatch before an appended admission can be narrated.
 */
test("a file collision and its admission produce one authoritative ordering", async (t) => {
  // The bug this covers, in the words of the person who hit it: the room said
  // '⚖️ "paste the 72 possible names an agent …" is waiting — "when a prompt
  // gets added to a thread …" has the files it needs. It starts the moment
  // that lands.' Two truncated walls of somebody's own prompt and three
  // clauses of justification, to say that one agent goes after another.
  //
  // Two separate faults produced that. The detector's own line never resolved
  // a name at all, and the resolver `announceArbitration` did use matched a
  // task's `agentId` against the *provider* id ("anthropic") when a real
  // agentId is named after the vendor ("test-agent-claude") — so it missed
  // every task and fell through to the objective it was written to replace.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "collisionroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "sequence",
      evidence: [
        {
          kind: "file_overlap",
          resources: ["services/api-gateway/src/server.ts"],
        },
      ],
      explanation: "file_overlap: services/api-gateway/src/server.ts (+20)",
    },
  });
  // The detector only identifies a conflicting pair. The admission is the
  // authoritative ordering: it says which task was actually held. These two
  // events used to produce opposite announcements for the same collision.
  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation:
        "Sequenced behind executing work on the same resources: " +
        "services/api-gateway/src/server.ts",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the collision was never announced",
    8_000,
  );

  const lines = await arbitrationLines(runtime, repo, ownerId);
  assert.deepEqual(
    lines,
    [
      {
        authorId: `${ownerId}:anthropic`,
        content:
          `⚖️ Looks like @Codex (${firstName}) has the same files open — ` +
          `I'll start once they're done.`,
        inThread: true,
      },
    ],
    `the collision did not produce one authoritative order: ${JSON.stringify(lines)}`,
  );
  const line = lines[0]?.content ?? "";
  // The specific things that made it unreadable, each named so a rewrite that
  // reintroduces one fails here rather than in somebody's channel.
  assert.doesNotMatch(
    line,
    /paste the 72 possible names/u,
    "the line quoted a task's objective back at the room",
  );
  assert.doesNotMatch(
    line,
    /nobody is surprised|the moment that lands|one at a time|both touch/u,
    "the line kept a justification clause",
  );
});

test("an arbitration hold is posted in the held task's thread under the agent's own account", async (t) => {
  // In the words of the person who asked for it: "if I have two agents
  // working, agent b would say looks like agent a is in node.js, I'll take
  // app.js, then move when they're done". The decision was already being made
  // and already being announced — in the channel, under the coordinator's
  // name, beside the thread it was about. So somebody following one agent's
  // work watched it go quiet with the explanation somewhere else.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "threadedholdroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the hold was never announced",
    8_000,
  );

  const [line] = await arbitrationLines(runtime, repo, ownerId);
  assert.equal(line?.inThread, true, "the hold stayed a room-level line");
  assert.equal(
    line?.authorId,
    `${ownerId}:anthropic`,
    "the hold was not attributed to the held task's own agent",
  );
  // The agent never names itself: it is the one speaking, and its name is
  // already on the bubble. What it names is the agent it is waiting for.
  assert.doesNotMatch(
    line?.content ?? "",
    new RegExp(`@Claude \\(${firstName}\\)`, "u"),
    "the agent talked about itself in the third person in its own thread",
  );
  assert.match(
    line?.content ?? "",
    new RegExp(`@Codex \\(${firstName}\\)`, "u"),
    "the hold did not name the agent being waited for",
  );

  // And exactly one line about the admission. The run's own generic account of
  // the same event — "Waiting my turn — files this plan needs are leased to
  // another task in flight" — is the same sentence with nobody in it, and two
  // of them in a row reads as two separate things having gone wrong.
  const replies = await threadRepliesFor(runtime, repo, ownerId, tasks.claude);
  assert.equal(
    replies.filter((reply) => reply.content.startsWith("⚖️")).length,
    1,
    `the admission was narrated twice: ${JSON.stringify(replies)}`,
  );
});

test("a collision no admission acts on is not announced at all", async (t) => {
  // This used to be the one line `narrateConflicts` existed for: "@Claude and
  // @Codex are working on related things but can run together." Both plans
  // admitted whole, neither refused anything, nobody waiting — an
  // announcement with no decision in it, in the room where people watch for
  // the ones that do have a decision in them. And when both tasks belonged to
  // one agent it came out "@Hades and @Hades", which is the coordinator
  // reporting a collision between somebody and themselves.
  //
  // So no disposition and no evidence is narrated here any more. What is left
  // is the collision an admission actually acts on, and that is spoken by
  // `announceArbitration`, off the event that knows who was held.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "advisoryroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  // Every shape the detector can record: a pair with nothing between them,
  // a real file overlap scored inside the notify band, and the intent-only
  // overlap the advisory line was written for.
  for (const detected of [
    { disposition: "concurrent", evidence: [] },
    {
      disposition: "concurrent_with_notification",
      evidence: [
        {
          kind: "file_overlap",
          resources: ["apps/web/public/app.js"],
          score: 40,
        },
      ],
    },
    {
      disposition: "concurrent_with_notification",
      evidence: [
        {
          kind: "intent_conflict",
          resources: ["mobile sizing"],
          score: 30,
          advisory: true,
        },
      ],
    },
  ]) {
    await runtime.store.appendAudit(undefined, {
      type: "conflict_detected",
      taskId: tasks.claude,
      data: {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: repo,
        taskIds: [tasks.claude, tasks.codex],
        ...detected,
      },
    });
  }

  // A collision that *is* acted on, appended last, as the proof the room was
  // reachable all along. Waiting on a line that must not appear proves
  // nothing; waiting on the next one that must, and then finding it alone,
  // proves both halves.
  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the arbitration was never announced",
    8_000,
  );

  const lines = (await arbitrationLines(runtime, repo, ownerId)).map(
    (line) => line.content,
  );
  assert.deepEqual(
    lines,
    [
      `⚖️ Looks like @Codex (${firstName}) has the same files open — ` +
        `I'll start once they're done.`,
    ],
    `a collision nobody was held by was still narrated: ${JSON.stringify(lines)}`,
  );
});

test("the hold is replaced by a first-person release line when the blocker finishes", async (t) => {
  // The other half of the same complaint. This path already tried to resolve a
  // name and always failed, so every hold in the room was two truncated
  // prompts; and having resolved one it then spent two more clauses on why.
  //
  // Where the line stands changed what happens when it stops being true. In
  // the room it was simply taken back, because nobody there was following this
  // run and a second announcement about it was noise. In the agent's own
  // thread the person reading has been waiting on exactly this, so the agent
  // says so — and the stale sentence goes, rather than standing above its own
  // contradiction.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "holdroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation:
        "Sequenced behind executing work on the same resources: " +
        "services/api-gateway/src/server.ts",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the hold was never announced",
    8_000,
  );

  const line = (await arbitrationLines(runtime, repo, ownerId))[0]?.content ?? "";
  assert.equal(
    line,
    `⚖️ Looks like @Codex (${firstName}) has the same files open — ` +
      `I'll start once they're done.`,
    `the hold did not read as one name and an order: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /paste the 72 possible names|has the files it needs|the moment that lands/u,
    "the hold kept the quoted objective or its justification clause",
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "approved",
      explanation: "The blocking work landed",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length === 0,
    "the expired hold stayed standing",
    8_000,
  );

  const replies = await threadRepliesFor(runtime, repo, ownerId, tasks.claude);
  assert.equal(
    replies.some(
      (reply) =>
        reply.content ===
        `@Codex (${firstName}) is done — picking this up now.`,
    ),
    true,
    `the released hold left the thread with nothing to say: ${JSON.stringify(
      replies,
    )}`,
  );
  // And the generic "Plan approved — starting on the code" is not said beside
  // it: the release is that sentence, with the reason in it.
  assert.equal(
    replies.some((reply) => /Plan approved/u.test(reply.content)),
    false,
    `the release was doubled by the canned admission line: ${JSON.stringify(
      replies,
    )}`,
  );
});

test("a blocked admission says who waits for whom, not that a plan is shrinking", async (t) => {
  // In the words of the person who hit it: "narrowing its plan makes it sound
  // like some of your specifications may be changed, which will off-put the
  // user if that actually isn't happening". What narrows on this path is the
  // claim on the repository, not the ask — but the room cannot tell those
  // apart, so the line has to report the one thing it knows: the order.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "blockedroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "blocked",
      blockedBy: [tasks.codex],
      explanation:
        "Plan collides with executing work beyond the sequencing threshold",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the block was never announced",
    8_000,
  );

  const line = (await arbitrationLines(runtime, repo, ownerId))[0]?.content ?? "";
  assert.equal(
    line,
    `⚖️ Looks like @Codex (${firstName}) has the same files open — ` +
      `I'll let them go first.`,
    `the block did not read as one name and an order: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /narrow/iu,
    "the block still described the held task's plan as shrinking",
  );
  // A hold, not an advisory: it retires when either end of the collision does,
  // which is only true while the line does not end the way the together line
  // ends.
  assert.equal(
    line.endsWith("can run together."),
    false,
    "a block was classified as a line about work that can run together",
  );
});

test("one agent holding two conflicting tasks is named once, with the order", async (t) => {
  // In the words of the person who hit it: "don't go like, at Hades and at
  // Hades are working on related things". One agent handed two tasks that
  // collide is arbitrated exactly like two agents that do, and both sides of
  // the line resolve to the same name — so the room was told "@Hades and
  // @Hades have conflicting files — @Hades will wait for @Hades to go first",
  // which names the only thing the reader already knew and none of what they
  // wanted. What they wanted is the order, and which task is which.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "oneagentroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );
  // The second half of the collision is the same agent's other task — the
  // vendor-resolved id the dispatched one carries, not the other vendor's.
  const alsoClaude = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "swap the retry timeout",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const held = (
    await runtime.store.listSubmittedTasks({ repositoryId: repo })
  ).find((task) => task.id === tasks.claude);
  assert.ok(held !== undefined, "the dispatched task went missing");
  const heldObjective = held.objective.split("\n")[0] ?? "";
  assert.ok(
    heldObjective.length <= 40,
    `the fixture objective is long enough to be truncated: ${heldObjective}`,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "blocked",
      blockedBy: [alsoClaude.id],
      explanation:
        "Plan collides with executing work beyond the sequencing threshold",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the one-agent collision was never announced",
    8_000,
  );

  const line = (await arbitrationLines(runtime, repo, ownerId))[0]?.content ?? "";
  assert.equal(
    line,
    `⚖️ I'm on two tasks that conflict — I'll do "swap the retry timeout" ` +
      `first, then "${heldObjective}".`,
    `the one-agent collision did not read as one agent and an order: ${line}`,
  );
  // The shape of the complaint, named so a rewrite cannot bring it back: in
  // its own thread the agent is not named at all, and never set against
  // itself.
  assert.equal(
    line.split(`@Claude (${firstName})`).length - 1,
    0,
    `the line named the agent whose thread it is in: ${line}`,
  );
  assert.doesNotMatch(
    line,
    /have conflicting files/u,
    "the line still described one agent's own two tasks as a collision between agents",
  );
});

test("a hold is taken back when the held task stops instead of starting", async (t) => {
  // An approved re-admission was the only thing that ever withdrew one of
  // these. Every other way out of a hold — the run failed, somebody cancelled
  // it, it never started — dropped the watcher and left "starts once the other
  // one is done" standing in the room as a promise about a run that no longer
  // exists. It is the commonest ending of the two: a held task is one that was
  // already in trouble.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "failedholdroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the hold was never announced",
    8_000,
  );

  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId: tasks.claude,
    data: { error: "npm test exited 1" },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length === 0,
    "the hold outlived the run it was about",
    8_000,
  );

  // The ending itself is untouched: what goes is the standing claim about when
  // this was going to start, not the account of what happened to it.
  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  assert.equal(
    messages.some(
      (message) =>
        message.kind === "outcome" ||
        (message.replies ?? []).some((reply) => reply.kind === "outcome"),
    ),
    true,
    `withdrawing the hold took the ending with it: ${JSON.stringify(
      messages.map((message) => message.content),
    )}`,
  );
});

test("notices left standing by a restart are swept once their collision is over", async (t) => {
  // The map that remembers which message to delete dies with the process, and
  // a hold is precisely the state that waits — across a deploy, routinely. So
  // the sweep decides from the store instead: the notice carries its task, and
  // a task that has stopped cannot still be waiting its turn.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "sweptroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the hold was never announced",
    8_000,
  );

  const sweep = async (): Promise<void> => {
    await (
      runtime.gateway as unknown as {
        reconcileArbitrationNotices(): Promise<void>;
      }
    ).reconcileArbitrationNotices();
  };

  // Both ends still running: the line is current, and a sweep that took it now
  // would be deleting the thread's only account of why this agent is idle.
  await sweep();
  assert.equal(
    (await arbitrationLines(runtime, repo, ownerId)).length,
    1,
    "the sweep took a hold that was still true",
  );

  // The blocker lands. Nothing re-admits the held task — the case no live path
  // reaches — and "I'll start once they're done" is now about something that
  // already happened.
  await runtime.store.cancelSubmittedTask(tasks.codex);
  await sweep();
  assert.deepEqual(
    await arbitrationLines(runtime, repo, ownerId),
    [],
    "the hold survived the work it was waiting on",
  );
});

test("a restart still finds and withdraws a hold it did not post", async (t) => {
  // The map recording which line to take back dies with the process, and being
  // held is precisely the state that waits — across a deploy, routinely. Now
  // that the line is a reply rather than a room-level message, finding it again
  // means reading the thread it hangs in: a hold written into a thread by a
  // deployment that is gone must still be withdrawable by the one that
  // replaces it, or the first agent to be held across a deploy keeps "I'll
  // start once they're done" over its head for the rest of the thread's life.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "restartholdroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the hold was never announced",
    8_000,
  );

  // The restart, as far as this line is concerned: everything the process
  // remembered about posting it is gone, and only the reply itself is left.
  const gateway = runtime.gateway as unknown as {
    arbitrationNotices: Map<string, unknown>;
    withdrawArbitrationNotice(watched: {
      projectId: string;
      repositoryId: string;
      taskId: string;
    }): Promise<void>;
  };
  gateway.arbitrationNotices.clear();

  await gateway.withdrawArbitrationNotice({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    taskId: tasks.claude,
  });
  assert.deepEqual(
    await arbitrationLines(runtime, repo, ownerId),
    [],
    "a hold this process had no memory of posting was left standing",
  );
});

test("an advisory line an older deployment left behind is still swept", async (t) => {
  // Nothing writes "they can run together" any more, but the deployments that
  // did are the same rooms people are still reading, and those lines are
  // present tense about two runs that are running. Left alone one becomes the
  // room's permanent last word on a collision that stopped mattering hours
  // ago — so the sweep still has to recognise it and take it back.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "advisorysweep");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  // Written straight into the room, which is the only way one can arrive now:
  // the process that posted it is gone, and all this one has is the message.
  await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "system",
    authorId: "coordinator",
    content:
      `⚖️ @Claude (${firstName}) and @Codex (${firstName}) are working on ` +
      `related things but can run together.`,
    taskId: tasks.claude,
  });

  const sweep = async (): Promise<void> => {
    await (
      runtime.gateway as unknown as {
        reconcileArbitrationNotices(): Promise<void>;
      }
    ).reconcileArbitrationNotices();
  };
  const coordinatorLines = async (): Promise<string[]> =>
    (await runtime.store.listChannelMessages(repo, ownerId))
      .filter((message) => message.authorId === "coordinator")
      .map((message) => String(message.content));

  // Still running: the line is out of date in its wording, not in its claim.
  await sweep();
  assert.equal(
    (await coordinatorLines()).length,
    1,
    "the sweep took an advisory line about a run that was still going",
  );

  await runtime.store.cancelSubmittedTask(tasks.claude);
  await sweep();
  assert.deepEqual(
    await coordinatorLines(),
    [],
    "the advisory line outlived the run it described",
  );
});

test("deleting a coordinator notice does not stop the task it names", async (t) => {
  // The notice carries a task id so a fresh process can find it again — and
  // the delete route stops the task behind any message it removes. A reader
  // tidying a stale hold out of their channel would otherwise have cancelled
  // somebody else's running agent, from a line that is not even that run's
  // thread.
  //
  // Written into the room by hand, because that is the only way a root-level
  // notice arrives now: it is the fallback for a task with no agent account to
  // speak for it, and the shape every line an older deployment left behind
  // still has.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "deleteroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "system",
    authorId: "coordinator",
    content:
      `⚖️ @Claude (${firstName}) and @Codex (${firstName}) have conflicting ` +
      `files — @Claude (${firstName}) starts once @Codex (${firstName}) is done.`,
    taskId: tasks.claude,
  });

  const notice = (await runtime.store.listChannelMessages(repo, ownerId)).find(
    (message) => message.authorId === "coordinator",
  );
  assert.ok(notice !== undefined, "the hold notice was not found");
  assert.equal(
    notice.taskId,
    tasks.claude,
    "the notice did not record the task it is about",
  );

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${notice.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(
    (removed.data as { cancelledTask?: boolean }).cancelledTask,
    false,
    "deleting the notice cancelled the run it named",
  );
  assert.deepEqual(runtime.cancelCalls, [], "the notice stopped a live run");
  const held = (await runtime.store.listSubmittedTasks({ repositoryId: repo }))
    .find((task) => task.id === tasks.claude);
  assert.notEqual(
    held?.status,
    "cancelled",
    "the task behind the notice was cancelled by a channel tidy-up",
  );
});

test("an agent with no connection this channel knows still falls back to its objective", async (t) => {
  // The fallback is the whole reason the resolver can be trusted: it names an
  // agent or it says nothing confident. A task submitted by somebody with no
  // matching connection has no name to use, and quoting a short objective
  // beats naming the wrong agent.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "namelessroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  await runtime.store.appendAudit(undefined, {
    type: "conflict_detected",
    taskId: tasks.claude,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      taskIds: [tasks.claude, tasks.codex],
      disposition: "sequence",
      evidence: [],
    },
  });
  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });

  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the collision was never announced",
    8_000,
  );

  const line = (await arbitrationLines(runtime, repo, ownerId))[0]?.content ?? "";
  // 37 characters and an ellipsis — the exact shape the room was showing when
  // this was reported, which is how the fallback was identified as the path
  // every hold was taking.
  assert.match(line, /"paste the 72 possible names an agent …"/u, line);
  assert.doesNotMatch(
    line,
    new RegExp(`@Codex \\(${firstName}\\)`, "u"),
    "an agent nobody is connected for was named anyway",
  );
});

test("a task with no resolvable agent account falls back to the coordinator system line", async (t) => {
  // The held task's own agent says the line — unless there is no agent account
  // to say it under, and then somebody still has to. Putting first-person words
  // in a thread with nobody behind them would attribute one agent's sentence to
  // whoever posted last, so the room says it in its own name instead, which is
  // what it did for everybody before these moved into threads.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const firstName = String(session.user.displayName).split(" ")[0] ?? "Owner";
  const repo = await invitableRepository(owner, "unattributedroom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const tasks = await roomWithTwoAgents(
    runtime,
    owner,
    repo,
    ownerId,
    firstName,
  );

  // The account the thread would have been written under, disconnected. The
  // run carries on — this is the shape of an agent removed from a channel, or
  // a credential withdrawn, while its work is still in flight.
  runtime.chatConnections.set(ownerId, []);

  await runtime.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId: tasks.claude,
    data: {
      status: "sequenced",
      blockedBy: [tasks.codex],
      explanation: "Sequenced behind executing work on the same resources",
    },
  });
  await waitFor(
    async () => (await arbitrationLines(runtime, repo, ownerId)).length > 0,
    "the collision was announced nowhere at all",
    8_000,
  );

  const [line] = await arbitrationLines(runtime, repo, ownerId);
  assert.equal(
    line?.inThread,
    false,
    "a first-person line was posted with no account to attribute it to",
  );
  assert.equal(line?.authorId, "coordinator");
  // Third person, because the room is speaking: "I'll start once they're done"
  // in the channel names nobody at all.
  assert.doesNotMatch(line?.content ?? "", /I'll/u, line?.content ?? "");
  assert.match(line?.content ?? "", /starts once/u, line?.content ?? "");
});

test("the sweep leaves a quiet task alone, and closes a thread its watcher abandoned", async (t) => {
  // Two halves of one confusion. The sweep decides a thread still needs an
  // ending from its replies, and a quick task's ending is deliberately not a
  // reply — so it pasted a second, canned one underneath, duplicating the
  // outcome and handing the task the room the narrator had spared it. And it
  // reads the task's status to know an ending is due, but a landed
  // conversational turn settles `open`, which was in no table here — so the
  // orphaned threads this sweep exists for were skipped on every pass.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "sweeproom");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} fix the typo in the README` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.ok(task !== undefined);

  await runtime.store.appendAudit(undefined, {
    type: "task_started",
    taskId: task.id,
    data: {},
  });
  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId: task.id,
    data: { error: "npm test exited 1" },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).some(
        (message) => message.kind === "outcome",
      ),
    "the quiet ending never reached the room",
    8_000,
  );

  // The run is over and its watcher is gone — the state a restart leaves.
  await runtime.store.claimSubmittedTasks(repo);
  await runtime.store.completeSubmittedTask(task.id, "failed");
  await (runtime.gateway as unknown as {
    reconcileFinishedThreads(): Promise<void>;
  }).reconcileFinishedThreads();

  const swept = await runtime.store.listChannelMessages(repo, ownerId);
  const quietRoot = swept.find((message) => message.taskId === task.id);
  // Only what the handoff put there remains under the root: the
  // acknowledgement — carrying the agent's own opening, which replaces the
  // canned sentence in place once it arrives — and the thread's name. The
  // sweep must not paste a canned ending beneath work whose ending is already
  // in the room, and comparing the whole list is what proves it did not.
  assert.deepEqual(
    (quietRoot?.replies ?? []).map((reply) => reply.content),
    ["On it.", "Task: fix the typo in the README"],
    "the sweep added narration to a quick task that had already ended flat",
  );
  assert.equal(
    swept.filter((message) => message.kind === "outcome").length,
    1,
    "the ending was said twice",
  );

  // And the other half: a user-rooted thread left mid-sentence across a
  // restart, on a turn that landed conversationally and so sits `open`.
  const stranded = await runtime.store.appendChannelMessage({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "@Claude refactor the auth module",
  });
  const turn = await runtime.store.submitTask({
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    objective: "refactor the auth module",
    agentId: "test-agent",
    validationCommands: [],
    conversationId: stranded.id,
  });
  await runtime.store.setChannelMessageTask(repo, stranded.id, turn.id);
  await runtime.store.addChannelReply({
    repositoryId: repo,
    messageId: stranded.id,
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
    kind: "agent",
  });
  await runtime.store.addChannelReply({
    repositoryId: repo,
    messageId: stranded.id,
    authorId: `${ownerId}:anthropic`,
    content: "Working on it…",
    kind: "progress",
  });
  await runtime.store.claimSubmittedTasks(repo);
  await runtime.store.openSubmittedTask(turn.id);

  await (runtime.gateway as unknown as {
    reconcileFinishedThreads(): Promise<void>;
  }).reconcileFinishedThreads();

  const closed = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.id === stranded.id);
  assert.ok(
    (closed?.replies ?? []).some((reply) => reply.kind === "outcome"),
    `an orphaned open turn was never given an ending: ${JSON.stringify(
      closed?.replies,
    )}`,
  );
});

test("a mention nobody answers to says so, instead of vanishing", async (t) => {
  // The browser roster layers this account's own agents on top of the
  // server's, so an agent connected in a way that stored no per-user
  // credential is offered by the composer's autocomplete while
  // `connectionsFor` has never heard of it. Every mention then disappeared,
  // in every channel, with nothing to distinguish "thinking" from "was never
  // there".
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "nobodyhome");
  // Deliberately no connections: this is the state being reproduced.
  runtime.chatConnections.set(ownerId, []);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "@Notus can you run an audit" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes("Nobody here answers to that"),
    );
  }, "the channel stayed silent about an unresolvable mention");

  const said = (await runtime.store.listChannelMessages(repo, ownerId))
    .map((message) => message.content)
    .join("\n");
  // It names the way out, not just the problem.
  assert.match(said, /this channel has no agents the server can reach/u);
  assert.match(said, /add it to this channel/u);
  assert.equal(runtime.submittedTasks.length, 0);
});

test("an ordinary @ in a message is not treated as addressing anyone", async (t) => {
  // The silence was right for these, which is why it was there. An email
  // address or a scoped package must not draw an answer about the roster.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "atsign");
  runtime.chatConnections.set(ownerId, []);

  for (const content of [
    "mail me at nathan@example.com when it lands",
    "run npm i @scope/package first",
  ]) {
    await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
      { method: "POST", body: { content } },
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 250));

  const said = (await runtime.store.listChannelMessages(repo, ownerId))
    .map((message) => message.content)
    .join("\n");
  assert.doesNotMatch(said, /Nobody here answers to that/u);
});

test("a personal agent cannot be made auditor, an org-wide one can", async (t) => {
  // An auditor spends its owner's account continuously and unprompted, and
  // promotion needs only `manage_project` — so without this rule an admin
  // could commit a colleague's personal subscription to a permanent cost
  // they never agreed to. An org-wide credential is already published as
  // spendable by other people's requests; that is the consent this needs.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "spend");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  const personal = await owner.request(`${channel}/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(personal.status, 409, JSON.stringify(personal.data));
  assert.equal(personal.data.error.code, "auditor_must_be_org_wide");

  // The same agent may still hold any ordinary role: the restriction is on
  // the one role that spends without being asked, not on the agent.
  const plain = await owner.request(`${channel}/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "Backend Engineer" },
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));

  const orgWide = await owner.request(`${channel}/${ownerId}:openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(orgWide.status, 200, JSON.stringify(orgWide.data));
});

test("the roster falls back to the stored call sign, not the vendor label", async (t) => {
  // The reported bug: reload into Lattice and the channel roster calls every
  // agent "Claude (Nathan)" again. Names lived only in the control plane's
  // local `provider-connections.json` — the file `connectionsFor` reads — so
  // a restart on a filesystem that did not keep it lost every name while the
  // database still held the channel. The store remembers, so the roster does.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "named");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await runtime.store.setAgentCallSign(ownerId, "anthropic", "Athena");

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  assert.equal(roster.data.agents.length, 1);
  assert.equal(roster.data.agents[0].name, "Athena");

  // Renaming your own agent from a channel renames it everywhere: the name is
  // the account's call sign, not a label this room happens to use, so the
  // second repository below answers to it without ever having been told.
  const second = await invitableRepository(owner, "named-too");
  await joinAllConnectedAgents(runtime, second);
  const renamed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "Scout" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");
  assert.equal(renamed.data.override.name, "Scout");
  const afterRename = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(afterRename.data.agents[0].name, "Scout");
  const elsewhere = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/agents`,
  );
  assert.equal(elsewhere.data.agents[0].name, "Scout");
  // Written where the account holds it, not as a per-room shadow of it.
  const signs = await runtime.store.listAgentCallSigns();
  assert.equal(signs.find((sign) => sign.userId === ownerId)?.callSign, "Scout");
  const overrides = await runtime.store.listChannelAgentOverrides(repo);
  assert.equal(overrides[`${ownerId}:anthropic`]?.name, undefined);
});

test("renaming an agent in Settings renames it in every repository", async (t) => {
  // The reported bug, from the other side: an agent renamed in one channel
  // kept its old name in the next, and Settings — which reads the account's
  // own connection — never showed the new one at all. One name, written
  // account-wide, and the per-repository names that used to shadow it are
  // cleared as part of the same write.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const first = await invitableRepository(owner, "one");
  const second = await invitableRepository(owner, "two");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, first);
  await joinAllConnectedAgents(runtime, second);
  // A name this room had given it before any of this existed, which is
  // exactly what used to survive a rename and keep answering to the old name.
  await runtime.store.setChannelAgentOverride(second, `${ownerId}:anthropic`, {
    name: "Vesta",
    role: "Backend Engineer",
  });

  const renamed = await owner.request("/api/v1/chat/providers/anthropic/settings", {
    method: "POST",
    body: { callSign: "Hermes" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  for (const repositoryId of [first, second]) {
    const roster = await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
    );
    assert.equal(roster.status, 200, JSON.stringify(roster.data));
    assert.equal(roster.data.agents[0].name, "Hermes");
  }
  // The role that room set is its own decision and survives the rename.
  const overrides = await runtime.store.listChannelAgentOverrides(second);
  assert.equal(overrides[`${ownerId}:anthropic`]?.name, undefined);
  assert.equal(overrides[`${ownerId}:anthropic`]?.role, "Backend Engineer");

  // And the name is the one a mention resolves against, everywhere.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/messages`,
    { method: "POST", body: { content: "@Hermes please look at this" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
});

test("a legacy vendor-wide channel name no longer shadows an account-wide rename", async (t) => {
  // The half of the report that survived the account-wide rename. A row keyed
  // by the bare provider names a *vendor*, not an agent, and clearing one on a
  // rename would rename every other person's agent on that vendor in that
  // room — so it is never cleared. Rooms carrying one from before agent-keyed
  // rows existed therefore kept answering to the old name after a rename made
  // anywhere. The call sign outranks it now.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const first = await invitableRepository(owner, "legacy-one");
  const second = await invitableRepository(owner, "legacy-two");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, first);
  await joinAllConnectedAgents(runtime, second);
  // Written by a deployment that only had the vendor to key on.
  await runtime.store.setChannelAgentOverride(second, "anthropic", {
    name: "Hera",
    role: "Backend Engineer",
  });

  const renamed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${first}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "Scout" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");

  for (const repositoryId of [first, second]) {
    const roster = await owner.request(
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
    );
    assert.equal(roster.status, 200, JSON.stringify(roster.data));
    assert.equal(roster.data.agents[0].name, "Scout");
  }
  // The room's own decision about the role is not a name and still stands.
  const rosterSecond = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/agents`,
  );
  assert.equal(rosterSecond.data.agents[0].role, "Backend Engineer");

  // And the new name is the one a mention resolves against there.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${second}/channel/messages`,
    { method: "POST", body: { content: "@Scout please look at this" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
});

test("a room's rename of one agent still wins, and an unnamed agent keeps the vendor-wide name", async (t) => {
  // The two things the rule above must not break: a deliberate per-agent
  // rename in one room is that room's to keep, and a legacy vendor-wide row
  // still names the agents that have no call sign of their own.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "legacy-kept");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
    // Never named — the pre-call-sign connection the legacy row is for.
    { provider: "openai", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await runtime.store.setChannelAgentOverride(repo, "openai", { name: "Hera" });
  await runtime.store.setChannelAgentOverride(repo, `${ownerId}:anthropic`, {
    name: "Vesta",
  });

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  const agents = roster.data.agents as Array<{ provider: string; name: string }>;
  assert.equal(
    agents.find((agent) => agent.provider === "anthropic")?.name,
    "Vesta",
  );
  assert.equal(agents.find((agent) => agent.provider === "openai")?.name, "Hera");
});

test("a call sign longer than the account allows is refused, not half-written", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "long-name");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:anthropic`,
    { method: "POST", body: { name: "N".repeat(41) } },
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "invalid_call_sign");
  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.data.agents[0].name, "Athena");
});

test("the roster reports the connection's own call sign, and that name answers", async (t) => {
  // The half the store's copy could not fix: the roster route rebuilt
  // `${AGENT_LABEL} (${owner})` for every agent and never looked at the name
  // the connection carries, so a deployment that still *had* every name showed
  // "Claude (Owner)" in every channel while the settings screen showed Athena.
  // The browser takes this route's answer as the single authority for what an
  // agent is called (`channelAgentsFor` in data.js), so this is the name.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "call-signs");
  runtime.chatConnections.set(session.user.id, [
    { provider: "anthropic", visibility: "personal", callSign: "Athena" },
    // Never named — the pre-call-sign connection whose fallback must stay.
    { provider: "openai", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/agents`,
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  const agents = roster.data.agents as any[];
  const named = agents.find((agent) => agent.provider === "anthropic");
  const unnamed = agents.find((agent) => agent.provider === "openai");
  assert.equal(named?.name, "Athena");
  assert.equal(unnamed?.name, "Codex (Owner)");

  // And the matcher agrees with the screen: the name the roster reports is
  // the name a mention resolves against, or people @mention what they can see
  // and nothing answers.
  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
    { method: "POST", body: { content: "@Athena please fix the login bug" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
  assert.equal(runtime.submittedTasks[0]?.vendor, "claude");
});

test("the auditor audits a canonical advance and posts what it finds", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "watched");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;
  const promoted = await owner.request(`${channel}/${ownerId}:openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  runtime.chatAnswer.text = [
    "FINDING",
    "severity: high",
    "files: src/server.ts",
    "selffix: no",
    "title: Inverted condition admits unauthorized callers",
    "detail: The guard was changed from && to ||, so either check passing is",
    "enough where both were required.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () =>
      (
        await runtime.store.listChannelMessages(repo, ownerId)
      ).some((message) =>
        message.replies.some((reply) => reply.content.includes("Audited")),
      ),
    "the auditor never posted its findings",
  );

  // It read the change it was woken by, not the whole tree.
  assert.equal(runtime.canonicalDiffs.length, 1);
  assert.equal(runtime.canonicalDiffs[0]?.fromRevision, "a".repeat(40));
  assert.equal(runtime.canonicalDiffs[0]?.toRevision, "b".repeat(40));
  // And it audited on its own account, unprompted.
  assert.equal(runtime.chatPrompts[0]?.userId, ownerId);
  assert.match(runtime.chatPrompts[0]?.prompt ?? "", /const ok = a \|\| b;/u);

  // One thread for every audit this repository will ever have, with the run's
  // summary and each finding inside it — not a thread per merge. Alongside it,
  // one line in the room: a bumped thread says something happened but not
  // whether it mattered, and a high finding read exactly like a routine
  // all-clear until somebody opened it.
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  assert.equal(posted.length, 2);
  const message = posted.find((entry) =>
    String(entry.content).startsWith("Audit log"),
  );
  // From the auditor rather than the deployment: an audit is an agent's own
  // reading of a change, so it arrives with a face like anything else said in
  // the room.
  const announced = posted.find((entry) =>
    String(entry.content).startsWith("Audit of"),
  );
  assert.equal(announced?.kind, "agent");
  assert.equal(announced?.authorId, `${ownerId}:openai`);
  assert.match(String(announced?.content), /1 issue \(1 high\)/u);
  assert.match(
    String(announced?.content),
    /Inverted condition admits unauthorized callers/u,
  );
  assert.equal(message?.authorId, `${ownerId}:openai`);
  assert.match(String(message?.content), /^Audit log/u);
  assert.equal(message?.replies.length, 2);
  assert.match(String(message?.replies[0]?.content), /Audited/u);
  assert.match(
    message?.replies[1]?.content ?? "",
    /1\. Inverted condition admits unauthorized callers/u,
  );

  // The cursor moved, so a restart does not audit this advance again.
  const cursor = await runtime.store.getAuditorCursor(repo);
  assert.equal(cursor?.revision, "b".repeat(40));
});

test("a clean audit reports that it ran, inside the audit thread", async (t) => {
  // Silence and "not running" look identical from outside, and until an
  // auditor has been watched working once, the difference is the only thing
  // anybody wants to know. It goes in the thread rather than the room, so the
  // channel is not the thing paying for it.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "clean");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = "NO FINDINGS";

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () => runtime.canonicalDiffs.length > 0,
    "the auditor never looked at the change",
  );
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the auditor never recorded that it had looked",
  );
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  // One message in the channel — the thread root — and the outcome inside it.
  assert.equal(posted.length, 1);
  assert.match(String(posted[0]?.content), /^Audit log/u);
  assert.equal(posted[0]?.replies.length, 1);
  assert.match(String(posted[0]?.replies[0]?.content), /nothing to report/u);
});

test("a repository with no auditor is never audited", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "unwatched");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  // Nothing to wait on, so this waits for the poller to have run at all and
  // then asserts it did nothing.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.canonicalDiffs, []);
  assert.deepEqual(await runtime.store.listChannelMessages(repo, ownerId), []);
});

test('approving a finding with "yes, do it" dispatches the fix', async (t) => {
  // The wording matters: `looksLikeTaskRequest` returns false for this, so
  // without the auditor's own approval reading the reply would fall through
  // to the agent answering a question about its own finding — which looks
  // exactly like it worked.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "approved");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: medium",
    "files: src/retry.ts",
    "selffix: yes",
    "title: Retry loop runs one time too many",
    "detail: The bound is inclusive where it should be exclusive.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "the auditor never posted its findings",
  );
  const [audit] = await runtime.store.listChannelMessages(repo, ownerId);
  assert.notEqual(audit, undefined);

  const reply = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "yes, do it" } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "approving the finding never dispatched a fix",
  );
  const [task] = runtime.submittedTasks;
  assert.match(task?.objective ?? "", /Retry loop runs one time too many/u);
  assert.match(task?.objective ?? "", /src\/retry\.ts/u);
  // Submitted against the auditor's owner, which is who agreed to spend.
  assert.equal(task?.actorId, ownerId);
  // The finding was marked self-fixable and nobody else was named, so the
  // auditor took it rather than handing it on.
  assert.equal(task?.repositoryId, repo);
});

test("a number is read against the newest audit, not the whole thread", async (t) => {
  // Every audit of a repository lands in one thread and findings are numbered
  // per audit, so the replies hold 1, 2, then 1 again. Read as one list, "fix
  // 1" matched two different findings and dispatched both.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "renumbered");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );

  const finding = (title: string) =>
    [
      "FINDING",
      "severity: medium",
      "files: src/one.ts",
      "selffix: yes",
      `title: ${title}`,
      "detail: Something worth fixing.",
      "END",
    ].join("\n");

  // Two audits into the same thread, each with its own finding numbered 1.
  const audits = [
    { title: "First audit finding", from: "a", to: "b" },
    { title: "Second audit finding", from: "b", to: "c" },
  ];
  for (const [index, entry] of audits.entries()) {
    runtime.chatAnswer.text = finding(entry.title);
    await runtime.store.appendAudit(undefined, {
      type: "canonical_promoted",
      taskId: `task-${String(index + 1)}`,
      data: {
        projectId: DEFAULT_PROJECT_ID,
        repositoryId: repo,
        previousRevision: entry.from.repeat(40),
        revision: entry.to.repeat(40),
      },
    });
    await waitFor(
      async () =>
        (await runtime.store.listChannelMessages(repo, ownerId)).some(
          (message) =>
            message.replies.some((r) => r.content.includes(entry.title)),
        ),
      `audit ${String(index + 1)} never posted`,
    );
  }

  // One thread holding both audits, which is the condition being tested. The
  // two room lines the findings announced are beside it, not more threads.
  const posted = await runtime.store.listChannelMessages(repo, ownerId);
  const audit = posted.find((entry) =>
    String(entry.content).startsWith("Audit log"),
  );
  assert.equal(
    posted.filter((entry) => String(entry.content).startsWith("Audit log"))
      .length,
    1,
  );
  assert.equal(audit?.replies.length, 4);

  const reply = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "yes, fix 1" } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "approving finding 1 never dispatched anything",
  );
  // Exactly one task, and it is the newest audit's finding — not both, and
  // not the older one that also happens to be numbered 1.
  assert.equal(runtime.submittedTasks.length, 1);
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /Second audit finding/u,
  );
});

test("a rejection in an auditor thread dispatches nothing", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "declined");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: low",
    "files: src/a.ts",
    "selffix: yes",
    "title: Redundant null check",
    "detail: The value cannot be null here.",
    "END",
  ].join("\n");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "the auditor never posted its findings",
  );
  const [audit] = await runtime.store.listChannelMessages(repo, ownerId);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${audit?.id}/replies`,
    { method: "POST", body: { content: "no, that is a false positive" } },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.submittedTasks, []);
});

/** Promotes an org-wide agent to auditor and returns the owner's id. */
test("auditing can be switched off, and merges during the pause are not audited", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "paused");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  const off = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.paused, true);

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(runtime.canonicalDiffs, []);

  // The roster reports the switch, so the toggle can be drawn from one read.
  const roster = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`,
  );
  assert.equal(roster.data.auditorPaused, true);
});

test("switching auditing back on audits the gap immediately", async (t) => {
  // The point of a pause rather than a demotion: the cursor is kept, so
  // resuming reviews what landed while it was off instead of skipping it.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "resumed");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  // One audit first, so there is a real revision to resume from.
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the first audit never ran",
  );
  assert.equal(runtime.canonicalDiffs.length, 1);

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  // Two merges land unseen while it is off.
  runtime.canonicalState.head = "d".repeat(40);
  runtime.chatAnswer.text = [
    "FINDING",
    "severity: high",
    "files: src/server.ts",
    "selffix: no",
    "title: Something landed while auditing was off",
    "detail: Found on resume.",
    "END",
  ].join("\n");

  const on = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: false } },
  );
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.paused, false);
  assert.equal(on.data.resumed, "audited");

  await waitFor(
    async () =>
      (await runtime.store.listChannelMessages(repo, ownerId)).length > 0,
    "resuming never produced an audit",
  );
  // The gap, in one range: from where it last finished to where canonical is
  // now — not from the event it missed, and not from the beginning.
  const resumeDiff = runtime.canonicalDiffs[1];
  assert.equal(resumeDiff?.fromRevision, "b".repeat(40));
  assert.equal(resumeDiff?.toRevision, "d".repeat(40));
  assert.equal((await runtime.store.getAuditorCursor(repo))?.paused, false);
});

test("resuming with nothing new to review says so and spends nothing", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "quiet");
  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  runtime.chatAnswer.text = "NO FINDINGS";

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-1",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  await waitFor(
    async () => (await runtime.store.getAuditorCursor(repo)) !== undefined,
    "the first audit never ran",
  );

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  // Canonical has not moved since the last audit.
  const on = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: false } },
  );
  assert.equal(on.data.resumed, "nothing_to_audit");
  assert.equal(runtime.canonicalDiffs.length, 1, "no second diff was read");
});

test("the auditor switch needs manage_project, and an auditor to switch", async (t) => {
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "switchguard");

  // Nothing holds the role yet.
  const none = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(none.status, 404, JSON.stringify(none.data));
  assert.equal(none.data.error.code, "no_auditor");

  await repositoryWithAuditor(runtime, owner, ownerId, repo);
  const guest = await joinRepository(
    runtime,
    owner,
    "switchguest@example.com",
    repo,
  );
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: true } },
  );
  assert.equal(
    refused.status === 200,
    false,
    "a collaborator must not switch auditing",
  );

  const bad = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/auditor`,
    { method: "POST", body: { paused: "yes" } },
  );
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
});

test("a collaborator cannot promote an auditor, but can still set a plain role", async (t) => {
  // The permission line: naming an agent's role is ordinary collaboration,
  // handing one the ability to spend on its own initiative is administration.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "guarded");
  const guest = await joinRepository(runtime, owner, "guest@example.com", repo);
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  const plain = await guest.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "Reviewer" },
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));

  const promotion = await guest.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promotion.status === 200, false, "a guest must not promote");
});

/**
 * Asked for a status report, agents called finished work outstanding.
 *
 * They were right about what they were shown. A conversational turn that
 * lands is set to `open` — the work is in canonical and the thread stays warm
 * for a follow-up — and the status list handed the model that word raw. "Open"
 * has a plain English meaning and it is the opposite of the one intended.
 */
