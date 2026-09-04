/** The gateway over HTTP: agents, rooms, repositories and their roles. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  ApiGateway,
  type ApiOperations,
} from "./server.js";
import {
  BOOTSTRAP_TOKEN,
  PASSWORD,
  TestClient,
  addColleague,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  loginAs,
  registerAccount,
  startRuntime,
  waitFor,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";

test("an investigator says why a task failed, and retries when told to", async (t) => {
  // A failure ended with one line and nobody read it. The reason was in the
  // audit trail, which nobody goes and reads either.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "investigator-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const promoted = await owner.request(`${base}/agents/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "investigator" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.id;
  assert.ok(taskId !== undefined);

  runtime.chatAnswer.text = [
    "VERDICT",
    "class: flaky_gate",
    "retry: yes",
    "detail: The gate failed on a timing assertion that passed twice before.",
    "END",
  ].join("\n");

  // A real failure is both: the row settles and the run traces it. The
  // investigator reads the trail; the retry reads the row.
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.completeSubmittedTask(taskId, "failed");
  await runtime.store.appendAudit(undefined, {
    type: "task_failed",
    taskId,
    data: { status: "validation_failed", explanation: "tests timed out" },
  });

  const thread = () =>
    runtime.store.listChannelMessages(repositoryId, ownerId).then((messages) =>
      messages.find(
        (message) => message.kind === "user" && message.taskId !== undefined,
      ),
    );
  await waitFor(async () => {
    const root = await thread();
    return (root?.replies ?? []).some((reply) =>
      /timing assertion/u.test(reply.content),
    );
  }, "the investigator never said why the task failed");

  const root = await thread();
  const verdict = (root?.replies ?? []).find((reply) =>
    /timing assertion/u.test(reply.content),
  );
  // Named as a kind of failure, not just restated.
  assert.match(verdict?.content ?? "", /fails intermittently/u);
  assert.match(verdict?.content ?? "", /yes, retry/u);

  // It must not have retried on its own — that is a spend loop.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "failed",
  );

  // The person says so, and only then does it go back in the queue.
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "yes, retry it" } },
  );
  assert.equal(replied.status, 201);
  await waitFor(async () => {
    const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
    return task?.status === "submitted";
  }, "the approved retry never re-queued the task");
});

test("a personal agent cannot be made investigator either", async (t) => {
  // Same rule as the auditor, for the same reason: nobody names it, so it
  // spends its owner's account unprompted.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "investigator-personal");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const refused = await owner.request(`${base}/agents/${ownerId}:anthropic`, {
    method: "POST",
    body: { role: "investigator" },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "investigator_must_be_org_wide");
});

test("asking to install a system package is answered, not queued for ten minutes", async (t) => {
  // What happened instead: the task planned no files, negotiated scope it
  // could never use, and was cancelled ten minutes later with "session
  // cancelled" — a sentence about the mechanism, with nothing in it the
  // reader could act on.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "system-install");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) apt-get install python3 and run the tests" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(
    runtime.submittedTasks.length,
    0,
    JSON.stringify(runtime.submittedTasks),
  );
  const after = await owner.request(`${base}/messages`);
  const answer = (after.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.ok(answer !== undefined, JSON.stringify(after.data.messages));
  // It names the file, because that is the real answer rather than a refusal.
  assert.match(answer.content, /control-plane\.Dockerfile/u);
});

test("an ordinary install of a dependency is still real work", async (t) => {
  // The refusal above has to be narrow. "install the eslint plugin" edits
  // package.json and is an ordinary change; guessing at intent from the word
  // "install" would refuse real work, which is worse than the wait it saves.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dependency-install");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) install the eslint plugin we discussed" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

test("renaming your own agent does not rename everybody else's on that vendor", async (t) => {
  // A bare provider id names a *vendor*, not an agent, and the reader applied
  // it to every agent on that vendor. One person renaming their own Claude
  // renamed their colleague's too — and their role label travelled with it,
  // which for the auditor role is a permanent spend commitment.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "rename-isolation");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const colleague = await addColleague(runtime, "rename-colleague@example.com");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Renamed the way the owner's own agent card does it: a bare provider id.
  const renamed = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { name: "Eos" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  const roster = await owner.request(`${base}/agents`);
  assert.equal(roster.status, 200);
  const byUser = new Map(
    (roster.data.agents as any[]).map((entry) => [entry.userId, entry]),
  );
  assert.equal(byUser.get(ownerId)?.name, "Eos");
  // The colleague's agent keeps its own name.
  assert.notEqual(byUser.get(colleague.id)?.name, "Eos");
});

test("only the user who added an agent can rename it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "rename-owner-only");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const colleague = await addColleague(runtime, "agent-owner@example.com");
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org", callSign: "Athena" },
  ]);
  const added = await colleague.client.request(
    `${base}/agents/anthropic/membership`,
    { method: "POST" },
  );
  assert.equal(added.status, 200, JSON.stringify(added.data));

  // Even the organization owner cannot rename a connection a colleague
  // brought in. Repository authority is not ownership of their agent.
  const refused = await owner.request(
    `${base}/agents/${colleague.id}:anthropic`,
    { method: "POST", body: { name: "Apollo" } },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "forbidden");

  const renamed = await colleague.client.request(
    `${base}/agents/${colleague.id}:anthropic`,
    { method: "POST", body: { name: "Artemis" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.scope, "account");
});

test("a renamed agent answers to its new name, and the roster says that name", async (t) => {
  // The bug in full: the server resolved overrides one way and the browser
  // another, so a rename showed on screen while the server still matched the
  // older per-agent name. Mentioning what you could see did nothing.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "rename-answers");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // An older per-agent override, from before names became account-wide.
  assert.equal(
    (await owner.request(`${base}/agents/${ownerId}:anthropic`, {
      method: "POST",
      body: { name: "Icarus" },
    })).status,
    200,
  );
  // Then the owner renames from their own agent card, which sends a bare id.
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Daedalus" },
    })).status,
    200,
  );

  // The roster reports the name the server will actually match, so the screen
  // and the matcher cannot disagree.
  const roster = await owner.request(`${base}/agents`);
  assert.equal(
    (roster.data.agents as any[])[0]?.name,
    "Daedalus",
    JSON.stringify(roster.data.agents),
  );

  // And mentioning that name dispatches.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Daedalus please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
});

/*
 * Opt-in channel membership: connecting a vendor CLI makes an agent usable,
 * not automatically present in every repository's channel. A repository that
 * predates opt-in grandfathers in whatever was reachable at its first roster
 * read (see `channelAgentConnections`'s doc comment). A repository created
 * after it has nothing predating it, so it grandfathers nothing — reported
 * from the app as "i created a new repo and my claude agent was already added
 * to it", which was the backfill firing on a channel with no prior roster to
 * protect.
 */

test("channel membership is opt-in: an older repository grandfathers once, a new one starts empty", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);

  // A repository that predates opt-in, written straight to the store the way
  // one already in the database at deploy time looks: never marked, so its
  // first roster read is the one-time backfill.
  await runtime.store.saveRepository({
    id: "legacy-repo",
    path: "/canonical/legacy-repo.git",
    branch: "main",
  });
  await runtime.store.linkRepository(DEFAULT_PROJECT_ID, "legacy-repo");
  const legacyBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/legacy-repo/channel`;
  const grandfathered = await owner.request(`${legacyBase}/agents`);
  assert.equal(grandfathered.status, 200, JSON.stringify(grandfathered.data));
  assert.deepEqual(
    grandfathered.data.agents.map((agent: any) => agent.provider).sort(),
    ["anthropic"],
    "an agent already working in a repository must not vanish mid-session",
  );

  // A repository created now has nothing predating it. Its roster is empty
  // until somebody chooses, even though the same agent is connected.
  const repositoryId = await invitableRepository(owner, "membership-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const fresh = await owner.request(`${base}/agents`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.deepEqual(
    fresh.data.agents,
    [],
    "a repository created just now has nothing to grandfather in",
  );

  // A second agent connects. It must not appear automatically either.
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  const stillEmpty = await owner.request(`${base}/agents`);
  assert.deepEqual(
    stillEmpty.data.agents,
    [],
    "a newly connected agent must not silently join a channel it was never added to",
  );

  // Explicitly adding works, and is idempotent.
  const added = await owner.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.member, true);
  const addedAgain = await owner.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(addedAgain.status, 200);

  const afterAdd = await owner.request(`${base}/agents`);
  assert.deepEqual(
    afterAdd.data.agents.map((agent: any) => agent.provider).sort(),
    ["openai"],
    "adding one agent adds exactly it",
  );

  // Removing takes it back out, and it also stops being @mentionable —
  // `channelAgentConnections` backs both the roster route and mention
  // resolution with the same membership-filtered set.
  const removed = await owner.request(`${base}/agents/openai/membership`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.member, false);
  const afterRemove = await owner.request(`${base}/agents`);
  assert.deepEqual(afterRemove.data.agents, []);
});

/** Logs a store-created user into a fresh client, the way every test below needs. */
test("a repository can be renamed without its id moving, and only by somebody who may manage it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "renamable-repo");
  const repoPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/renamable-repo`;

  const renamed = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "Lattice Web" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.repository.displayName, "Lattice Web");
  // The id is what every other row and route addresses, so it never moves.
  assert.equal(renamed.data.repository.id, "renamable-repo");
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    "Lattice Web",
  );
  const events = await runtime.store.listAuditEvents({
    types: ["repository_renamed"],
  });
  assert.equal(events.length, 1);

  // An empty name is a clear rather than an error: back to being called by
  // the id, which is the only way to undo a rename.
  const cleared = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.repository.displayName, undefined);
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    undefined,
  );

  const tooLong = await owner.request(repoPath, {
    method: "PATCH",
    body: { name: "x".repeat(81) },
  });
  assert.equal(tooLong.status, 400);

  // A developer who neither created it nor holds manage_project is refused,
  // exactly as they are for deletion.
  const developer = await runtime.store.createUser({
    email: "renamer-dev@example.com",
    displayName: "Renamer Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  const refused = await devClient.request(repoPath, {
    method: "PATCH",
    body: { name: "Not Mine" },
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (await runtime.store.getRepository("renamable-repo"))?.displayName,
    undefined,
  );
});

test("a room is created with the visibility that was asked for", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "vis-repo");
  const channels = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/vis-repo/channels`;

  // Each of the three the dialog offers, plus the old name for the middle one
  // and a value nobody recognises, which falls back to the safe end.
  for (const [asked, stored] of [
    ["public", "public"],
    ["read_only", "read_only"],
    ["private", "private"],
    ["open", "read_only"],
    ["nonsense", "read_only"],
  ] as const) {
    const slug = `room-${asked}`;
    const created = await owner.request(channels, {
      method: "POST",
      body: { slug, name: slug, visibility: asked },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(
      created.data.channel.visibility,
      stored,
      `asked for ${asked}`,
    );
  }

  // And #general is public — everybody reads it and everybody posts in it,
  // which is what the gateway has always enforced by slug. It used to be
  // stored `read_only`'s old name and so was labelled "Read-only" on a screen
  // that also said, correctly, that it is always open.
  const listed = await owner.request(channels);
  const general = (listed.data.channels as { slug: string; visibility: string; canPost: boolean }[])
    .find((channel) => channel.slug === "general");
  assert.equal(general?.visibility, "public", JSON.stringify(listed.data));
  assert.equal(general?.canPost, true);
});

test("the room list carries each room's unread count for the caller", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "unread-repo");
  const channelsPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/unread-repo/channels`;

  const created = await owner.request(channelsPath, {
    method: "POST",
    body: { slug: "backend", name: "backend", visibility: "open" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const backendId = created.data.channel.id;

  // Somebody else's messages: one root plus a reply in #general, one root in
  // #backend. A reply counts — a thread answered while you were away is
  // something you missed.
  const other = await runtime.store.createUser({
    email: "unread-other@example.com",
    displayName: "Other",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: other.id,
    role: "developer",
  });
  const root = await runtime.store.appendChannelMessage({
    repositoryId: "unread-repo",
    projectId: DEFAULT_PROJECT_ID,
    authorId: other.id,
    content: "Something in general.",
  });
  await runtime.store.addChannelReply({
    repositoryId: "unread-repo",
    messageId: root.id,
    authorId: other.id,
    content: "And an answer.",
  });
  await runtime.store.appendChannelMessage({
    repositoryId: "unread-repo",
    projectId: DEFAULT_PROJECT_ID,
    channelId: backendId,
    authorId: other.id,
    content: "Something in backend.",
  });

  const listed = await owner.request(channelsPath);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const rooms = new Map(
    (listed.data.channels as { id: string; slug: string; unread: number }[]).map(
      (channel) => [channel.slug, channel],
    ),
  );
  assert.equal(rooms.get("general")?.unread, 2, JSON.stringify(listed.data));
  assert.equal(rooms.get("backend")?.unread, 1, JSON.stringify(listed.data));

  // Reading one room clears that room's badge and leaves the other's alone.
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/unread-repo/channel/read?channelId=${encodeURIComponent(backendId)}`,
    { method: "POST" },
  );
  const after = await owner.request(channelsPath);
  const afterRooms = new Map(
    (after.data.channels as { slug: string; unread: number }[]).map(
      (channel) => [channel.slug, channel],
    ),
  );
  assert.equal(afterRooms.get("backend")?.unread, 0, JSON.stringify(after.data));
  assert.equal(afterRooms.get("general")?.unread, 2, JSON.stringify(after.data));
});

test("a workspace picture is the workspace's: set only by a manager, read by everyone", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "pictured-repo");
  const picturePath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/pictured-repo/picture`;
  const PICTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

  const set = await owner.request(picturePath, {
    method: "PUT",
    body: { picture: PICTURE },
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.repository.picture, PICTURE);
  assert.equal(
    (await runtime.store.getRepository("pictured-repo"))?.picture,
    PICTURE,
  );
  assert.equal(
    (
      await runtime.store.listAuditEvents({
        types: ["repository_picture_changed"],
      })
    ).length,
    1,
  );

  // The point of the whole change: a colleague who can see the repository is
  // sent the picture in the list their workspace rail is drawn from. While it
  // lived in the setter's browser this was the one thing it could never do.
  const developer = await runtime.store.createUser({
    email: "picture-dev@example.com",
    displayName: "Picture Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  const listed = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(
    listed.data.repositories.find(
      (entry: { id: string }) => entry.id === "pictured-repo",
    )?.picture,
    PICTURE,
  );

  // Seeing it is not setting it. A developer who neither created the
  // repository nor holds manage_project is refused, as they are for renaming.
  const refused = await devClient.request(picturePath, {
    method: "PUT",
    body: { picture: "data:image/png;base64,iVBORw0KGgo=" },
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (await runtime.store.getRepository("pictured-repo"))?.picture,
    PICTURE,
  );

  // Anything that is not a base64 image data URL is refused. This value ends
  // up in every colleague's `<img src>`, so a caller that skipped the resize
  // and one aiming a URL of its own choosing get the same answer.
  for (const bad of [
    "https://example.com/tracker.png",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    const rejected = await owner.request(picturePath, {
      method: "PUT",
      body: { picture: bad },
    });
    assert.equal(rejected.status, 400, `${bad} should be refused`);
  }
  const oversized = await owner.request(picturePath, {
    method: "PUT",
    body: { picture: `data:image/jpeg;base64,${"A".repeat(256 * 1024)}` },
  });
  assert.equal(oversized.status, 400);
  assert.equal(
    (await runtime.store.getRepository("pictured-repo"))?.picture,
    PICTURE,
  );

  // An empty picture clears it, the way an empty name clears a rename, and
  // leaves the name alone — the two are separate routes for exactly this.
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/pictured-repo`,
    { method: "PATCH", body: { name: "Lattice" } },
  );
  const cleared = await owner.request(picturePath, {
    method: "PUT",
    body: { picture: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.repository.picture, undefined);
  assert.equal(cleared.data.repository.displayName, "Lattice");
});

test("a repository is reported by the name it was renamed to, and the rename moves nothing else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`;

  // Every consumer of these payloads — the browser, and whatever reads the
  // list over MCP — had to know that `displayName` beats `id` and that absent
  // means "call it by the id". Anything that did not know went on showing the
  // handle to somebody who had renamed the repository precisely so they would
  // stop seeing it. `name` is that resolution, done once, on the way out.
  const created = await owner.request(base, {
    method: "POST",
    body: { id: "lattice", branch: "main" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.repository.id, "lattice");
  assert.equal(created.data.repository.name, "lattice");
  assert.equal(created.data.repository.displayName, undefined);

  // Something for the rename to leave alone: a second room, a member in it,
  // and a colleague holding a grant on the repository.
  const room = await owner.request(`${base}/lattice/channels`, {
    method: "POST",
    body: { name: "Design Review", visibility: "private" },
  });
  assert.equal(room.status, 201, JSON.stringify(room.data));
  const colleague = await runtime.store.createUser({
    email: "renamed-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "viewer",
  });
  const granted = await owner.request(
    `${base}/lattice/grants/${colleague.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  const roomsBefore = await owner.request(`${base}/lattice/channels`);
  const grantsBefore = await owner.request(`${base}/lattice/grants`);

  const renamed = await owner.request(`${base}/lattice`, {
    method: "PATCH",
    body: { name: "Kumi" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.repository.name, "Kumi");
  assert.equal(renamed.data.repository.displayName, "Kumi");
  // The handle does not move. It keys every row and names the mirror on disk,
  // so the route that addressed this repository a moment ago still does.
  assert.equal(renamed.data.repository.id, "lattice");

  const listed = await owner.request(base);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.deepEqual(
    listed.data.repositories.map(
      (repository: { id: string; name: string }) => [
        repository.id,
        repository.name,
      ],
    ),
    [["lattice", "Kumi"]],
  );

  // Membership, rooms and repository access are exactly as they were.
  const roomsAfter = await owner.request(`${base}/lattice/channels`);
  assert.deepEqual(
    roomsAfter.data.channels.map((channel: { slug: string }) => channel.slug),
    roomsBefore.data.channels.map((channel: { slug: string }) => channel.slug),
  );
  const grantsAfter = await owner.request(`${base}/lattice/grants`);
  assert.deepEqual(
    grantsAfter.data.grants.map(
      (grant: { userId: string; role: string }) => [grant.userId, grant.role],
    ),
    grantsBefore.data.grants.map(
      (grant: { userId: string; role: string }) => [grant.userId, grant.role],
    ),
  );
  assert.equal(
    (await runtime.store.listMemberships(DEFAULT_ORGANIZATION_ID)).some(
      (membership) => membership.userId === colleague.id,
    ),
    true,
  );
  const colleagueClient = await loginAs(runtime.origin, colleague.email);
  const stillReachable = await colleagueClient.request(base);
  assert.deepEqual(
    stillReachable.data.repositories.map(
      (repository: { name: string }) => repository.name,
    ),
    ["Kumi"],
  );

  // Clearing the name is how a rename is undone, and the resolved name goes
  // back to the handle rather than to nothing.
  const cleared = await owner.request(`${base}/lattice`, {
    method: "PATCH",
    body: { name: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.repository.displayName, undefined);
  assert.equal(cleared.data.repository.name, "lattice");
});

test("a repository's creator can rename it without manage_project, but deleting it is the owner's alone", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const developer = await runtime.store.createUser({
    email: "creator-dev@example.com",
    displayName: "Creator Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  await invitableRepository(devClient, "dev-created-repo");
  assert.equal(
    (await runtime.store.getRepository("dev-created-repo"))?.createdBy,
    developer.id,
  );

  // A colleague who is also only a developer — not the creator, and no
  // manage_project — cannot delete it.
  const colleague = await runtime.store.createUser({
    email: "colleague-dev@example.com",
    displayName: "Colleague Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueClient = await loginAs(runtime.origin, colleague.email);
  const colleagueAttempt = await colleagueClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(colleagueAttempt.status, 403);
  assert.notEqual(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );

  // A total stranger — no membership, no grant — gets the same refusal.
  const stranger = new TestClient(runtime.origin);
  await registerAccount(runtime.store, stranger, {
    email: "stranger-delete@example.com",
    displayName: "Stranger",
    password: PASSWORD,
  });
  const strangerAttempt = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(strangerAttempt.status, 403);

  // The developer who created it can still rename it, despite lacking
  // manage_project — the creator's own additional path in.
  const renamed = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "PATCH", body: { name: "Their own repository" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));

  // Deleting it is another matter: it is irreversible and cascades the
  // channel, the grants and the history, so creating a repository does not
  // by itself entitle anyone to destroy it. Ownership does.
  const creatorAttempt = await devClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(creatorAttempt.status, 403, JSON.stringify(creatorAttempt.data));
  assert.notEqual(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );

  // The organization's owner can, and the deletion is audited.
  const deleted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/dev-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.removed, true);
  assert.equal(
    await runtime.store.getRepository("dev-created-repo"),
    undefined,
  );
  const events = await runtime.store.listAuditEvents({
    types: ["repository_deleted"],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.data["repositoryId"], "dev-created-repo");
});

test("an organization admin cannot delete a repository they did not create", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "owner-created-repo");

  const admin = await runtime.store.createUser({
    email: "admin-not-creator@example.com",
    displayName: "Admin",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: admin.id,
    role: "admin",
  });
  const adminClient = await loginAs(runtime.origin, admin.email);

  // manage_project is enough to administer a repository — renaming it,
  // moderating it, deciding who is on it — and deliberately not enough to
  // delete it out from under everyone working there.
  const refused = await adminClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/owner-created-repo`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.notEqual(
    await runtime.store.getRepository("owner-created-repo"),
    undefined,
  );

  const renamed = await adminClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/owner-created-repo`,
    { method: "PATCH", body: { name: "Still theirs to rename" } },
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
});

test("only an organization owner or a repository co-owner can delete a repository", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "co-owned-repo");

  // Somebody whose whole access is one repository-scoped grant: no
  // organization membership at all. At `developer` the grant reaches the
  // repository but not its deletion.
  const guest = await runtime.store.createUser({
    email: "co-owner-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "co-owned-repo",
    userId: guest.id,
    role: "developer",
    grantedBy: undefined,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const guestClient = await loginAs(runtime.origin, guest.email);
  const refused = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/co-owned-repo`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.notEqual(
    await runtime.store.getRepository("co-owned-repo"),
    undefined,
  );

  // Promoted to co-owner — an `owner` grant on this repository, which is what
  // the People row's "Promote to co-owner" writes — the same person can.
  await runtime.store.saveRepositoryGrant({
    repositoryId: "co-owned-repo",
    userId: guest.id,
    role: "owner",
    grantedBy: undefined,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const deleted = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/co-owned-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(
    await runtime.store.getRepository("co-owned-repo"),
    undefined,
  );
});

test("an active repository name is unique and becomes reusable after deletion", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositories = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`;

  const created = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const duplicate = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(duplicate.status, 422, JSON.stringify(duplicate.data));
  assert.equal(duplicate.data.error.code, "repository_creation_failed");

  const removed = await owner.request(`${repositories}/reusable-repo`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  const recreated = await owner.request(repositories, {
    method: "POST",
    body: { id: "reusable-repo" },
  });
  assert.equal(recreated.status, 201, JSON.stringify(recreated.data));
});

test("deleting a missing repository still reports not found", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const missing = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/missing-repo`,
    { method: "DELETE" },
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(missing.data.error.code, "not_found");
});

test("the auditor is told what the work was asked to do", async (t) => {
  // A diff can only be judged against itself, which leaves the most valuable
  // defect invisible: code that is perfectly reasonable and does something
  // other than what was requested. The investigator has always been given the
  // objective; the auditor, whose whole job is judging whether work is right,
  // never was.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "intent");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents/${ownerId}:openai`,
    { method: "POST", body: { role: "auditor" } },
  );

  const submitted = await runtime.store.submitTask({
    repositoryId: repo,
    objective: "Log the raw API key so failed shares can be debugged",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: ownerId,
  });
  // The reply is beside the point here; what is under test is the prompt.
  runtime.chatAnswer.text = "NO FINDINGS";
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: submitted.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });

  await waitFor(
    async () => runtime.chatPrompts.length > 0,
    "the auditor never ran",
  );
  assert.match(
    runtime.chatPrompts[0]?.prompt ?? "",
    /Log the raw API key so failed shares can be debugged/u,
  );
});

test("an image posted to a channel comes back as an image, and nothing else does", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "with-pictures");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/attachments`;

  const stored = await owner.request(base, {
    method: "POST",
    raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    rawType: "image/png",
  });
  assert.equal(stored.status, 200, JSON.stringify(stored.data));
  const id = (stored.data as { id?: string }).id ?? "";
  assert.match(id, /\.png$/u);

  const fetched = await owner.request(`${base}/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  // The type is derived from an allowlist rather than from whoever uploaded
  // the bytes, and this header is what stops a browser overriding it and
  // treating them as something it will execute.
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");

  // SVG is a document that can carry script, so serving one from this origin
  // would be self-inflicted cross-site scripting. Refused, not stored.
  const refused = await owner.request(base, {
    method: "POST",
    raw: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"),
    rawType: "image/svg+xml",
  });
  assert.notEqual(refused.status, 200);

  const missing = await owner.request(`${base}/${"b".repeat(32)}.png`);
  assert.equal(missing.status, 404);
});

test("reverting a task rolls back to the state before that task landed", async (t) => {
  // The channel knows which task a message belongs to and nothing about
  // revisions, so "revert this" travels as a task id and the server is what
  // turns it into the revision that task moved canonical away from.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "revertible");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-planted",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  runtime.canonicalState.head = "b".repeat(40);

  const reverted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/rollback`,
    { method: "POST", body: { taskId: "task-planted" } },
  );
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  // The revision before that task, not the one it produced.
  assert.deepEqual(runtime.rollbacks, [
    { repositoryId: repo, targetRevision: "a".repeat(40) },
  ]);
});

test("reverting a task is refused once canonical has moved past it", async (t) => {
  // Undoing this task would take the work that landed after it with it. The
  // button says "revert this task", so doing more than that is refused rather
  // than done quietly — and refused with a reason, since a rollback that will
  // not happen is a considered answer, not a transport failure.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "moved-on");

  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: "task-early",
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId: repo,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
    },
  });
  // Somebody else landed something afterwards.
  runtime.canonicalState.head = "c".repeat(40);

  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/rollback`,
    { method: "POST", body: { taskId: "task-early" } },
  );
  assert.equal(refused.status, 200, JSON.stringify(refused.data));
  assert.equal(
    (refused.data as { rollback?: { status?: string } }).rollback?.status,
    "blocked",
  );
  assert.deepEqual(runtime.rollbacks, []);
});

test("deleting a repository takes its queued work with it", async (t) => {
  // This asserted the opposite until the cascade landed: that a task
  // referencing the repository refused the deletion. In production that
  // refusal arrived as a raw foreign-key error with nothing offering to clear
  // the history behind it, so a repository that had ever done work could not
  // be removed at all. The store-contract tests carry the same reversal and
  // the reasoning for it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "cascading-repo");

  await runtime.store.submitTask({
    repositoryId: "cascading-repo",
    objective: "Do something",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: bootstrapped.user.id,
  });

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascading-repo`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(await runtime.store.getRepository("cascading-repo"), undefined);
  // The queue went with it rather than being left pointing at a repository
  // that no longer exists.
  assert.deepEqual(
    await runtime.store.listSubmittedTasks({
      repositoryId: "cascading-repo",
    }),
    [],
  );
});

test("deleting a repository with no task or run referencing it cascades its channel", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "cascade-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascade-repo/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A message that had better not survive deletion." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  const deleted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/cascade-repo`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(await runtime.store.getRepository("cascade-repo"), undefined);
  assert.deepEqual(
    await runtime.store.listChannelMessages("cascade-repo", bootstrapped.user.id),
    [],
  );
});

test("promoting an existing member to repository owner actually grants the capability, through the real authorization pipeline", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "promote-repo");

  const member = await runtime.store.createUser({
    email: "viewer-to-promote@example.com",
    displayName: "Viewer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: member.id,
    role: "viewer",
  });
  const memberClient = await loginAs(runtime.origin, member.email);

  // Before promotion: a plain viewer cannot delete (proxy for manage_project).
  const before = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo`,
    { method: "DELETE" },
  );
  assert.equal(before.status, 403);

  // A non-member/non-admin cannot promote anybody either.
  const unauthorizedPromote = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(unauthorizedPromote.status, 403);

  // The owner promotes the viewer to repository-scoped owner.
  const promoted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
  assert.equal(promoted.data.grant.role, "owner");

  const grants = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo/grants`,
  );
  assert.equal(grants.status, 200);
  assert.equal(grants.data.grants.length, 1);
  assert.equal(grants.data.grants[0].userId, member.id);
  assert.equal(grants.data.grants[0].user.displayName, "Viewer");

  // After promotion: the same viewer — organization role unchanged — can now
  // do something that requires manage_project on this one repository. This
  // proves the grant actually composes with organization role through
  // `authorizeRepository`, not just that the grant row exists.
  const after = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-repo`,
    { method: "DELETE" },
  );
  assert.equal(after.status, 200, JSON.stringify(after.data));
  assert.equal(
    await runtime.store.getRepository("promote-repo"),
    undefined,
  );
});

test("promoting a repository-only guest to co-owner does not require organization membership", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "promote-guest-repo");

  const guest = await runtime.store.createUser({
    email: "guest-to-promote@example.com",
    displayName: "Repository Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "promote-guest-repo",
    userId: guest.id,
    role: "viewer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });

  const promoted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-guest-repo/grants/${guest.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
  assert.equal(promoted.data.grant.role, "owner");
  assert.equal(
    await runtime.store.getMembership(DEFAULT_ORGANIZATION_ID, guest.id),
    undefined,
  );

  // An unrelated account still cannot be added merely by knowing its id.
  const stranger = await runtime.store.createUser({
    email: "stranger-not-in-repo@example.com",
    displayName: "Stranger",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const rejected = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/promote-guest-repo/grants/${stranger.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal(rejected.status, 404, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error.code, "not_found");
});

test("revoking a repository grant does not orphan the repository — organization role still reaches it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  await invitableRepository(owner, "revoke-repo");

  const member = await runtime.store.createUser({
    email: "revoke-target@example.com",
    displayName: "Target",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: member.id,
    role: "viewer",
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo/grants/${member.id}`,
    { method: "POST", body: { role: "owner" } },
  );
  assert.equal((await runtime.store.listRepositoryGrants("revoke-repo")).length, 1);

  const revoked = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo/grants/${member.id}`,
    { method: "DELETE" },
  );
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal((await runtime.store.listRepositoryGrants("revoke-repo")).length, 0);

  // The promoted member lost the elevation the grant gave them...
  const memberClient = await loginAs(runtime.origin, member.email);
  const memberAttempt = await memberClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo`,
    { method: "DELETE" },
  );
  assert.equal(memberAttempt.status, 403);

  // ...but the repository is not stranded: the organization owner's
  // blanket, role-based access was never routed through the grant, so it
  // still reaches the repository — no "last owner" guard is needed here the
  // way organization membership needs one.
  const ownerStillWorks = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/revoke-repo`,
    { method: "DELETE" },
  );
  assert.equal(ownerStillWorks.status, 200, JSON.stringify(ownerStillWorks.data));
});

test("a human can leave a repository held only through a grant, but not one reached through an organization role", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "leave-repo");

  const guest = await runtime.store.createUser({
    email: "leave-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: "leave-repo",
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const guestClient = await loginAs(runtime.origin, guest.email);

  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/channel`;
  assert.equal((await guestClient.request(`${base}/messages`)).status, 200);

  const left = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/grants/${guest.id}`,
    { method: "DELETE" },
  );
  assert.equal(left.status, 200, JSON.stringify(left.data));
  assert.equal(
    await guestClient.request(`${base}/messages`).then((r) => r.status),
    403,
  );

  // A colleague reached through an ordinary organization role — not a
  // grant — gets a legible refusal instead of a silent no-op or a 404 that
  // reads as "you were never here".
  const colleague = await runtime.store.createUser({
    email: "leave-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueClient = await loginAs(runtime.origin, colleague.email);
  const colleagueLeave = await colleagueClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/leave-repo/grants/${colleague.id}`,
    { method: "DELETE" },
  );
  assert.equal(colleagueLeave.status, 409);
  assert.equal(
    colleagueLeave.data.error.code,
    "org_membership_reaches_repository",
  );
});

test("only the user who added an agent can remove it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  await invitableRepository(owner, "moderation-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/moderation-repo/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  // Consumes the one-time grandfather backfill (see `channelAgentConnections`
  // in server.ts) so the explicit add/remove below is testing opt-in
  // membership, not whatever the first-ever read happened to grandfather in.
  await owner.request(`${base}/agents`);
  const added = await owner.request(`${base}/agents/anthropic/membership`, {
    method: "POST",
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  // A developer with no elevated permission cannot remove the owner's agent.
  const developer = await runtime.store.createUser({
    email: "mod-dev@example.com",
    displayName: "Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: developer.id,
    role: "developer",
  });
  const devClient = await loginAs(runtime.origin, developer.email);
  const devAttempt = await devClient.request(
    `${base}/agents/anthropic/membership?userId=${bootstrapped.user.id}`,
    { method: "DELETE" },
  );
  assert.equal(devAttempt.status, 403);

  // An admin still cannot remove somebody else's agent. Repository authority
  // does not transfer ownership of the connection that powers it.
  const admin = await runtime.store.createUser({
    email: "mod-admin@example.com",
    displayName: "Admin",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: admin.id,
    role: "admin",
  });
  const adminClient = await loginAs(runtime.origin, admin.email);
  const adminRemoval = await adminClient.request(
    `${base}/agents/anthropic/membership?userId=${bootstrapped.user.id}`,
    { method: "DELETE" },
  );
  assert.equal(adminRemoval.status, 403, JSON.stringify(adminRemoval.data));
  assert.equal(adminRemoval.data.error.code, "forbidden");
  const rosterAfterModeration = await owner.request(`${base}/agents`);
  assert.equal(rosterAfterModeration.data.agents.length, 1);

  // Self-service removal still needs only submit_task — the plain developer
  // above, with no manage_project, can remove their own membership.
  runtime.chatConnections.set(developer.id, [{ provider: "openai" }]);
  const devAdded = await devClient.request(`${base}/agents/openai/membership`, {
    method: "POST",
  });
  assert.equal(devAdded.status, 200, JSON.stringify(devAdded.data));
  const devSelfRemoval = await devClient.request(
    `${base}/agents/openai/membership`,
    { method: "DELETE" },
  );
  assert.equal(devSelfRemoval.status, 200, JSON.stringify(devSelfRemoval.data));
});

test("creating a repository ignores a mode field rather than importing", async (t) => {
  // The bug this pins. The dashboard used to post `{mode: "github", …}` to
  // the plain creation route, which reads no `mode` at all: the request
  // succeeded, answered 201 with a repository, and produced an *empty* one —
  // a single "Initial commit" and none of the remote's history. It looked
  // exactly like a working import until somebody opened the files.
  //
  // Creation keeping its behaviour is correct; what was wrong was the caller.
  // So this asserts the shape that misled, so the next person to add a `mode`
  // sees that nothing consumes it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const created = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`,
    {
      method: "POST",
      body: {
        id: "looks-imported",
        mode: "github",
        repository: "octocat/Hello-World",
      },
    },
  );
  assert.equal(created.status, 201);
  // No remote was recorded, because none was read: this is a local creation.
  assert.equal(created.data.repository.provider, undefined);
  assert.equal(created.data.repository.remoteUrl, undefined);
});

test("auditor is a reserved role: owner-only, and one to a repository", async (t) => {
  // Every other role is free text the agent only ever reads as a sentence.
  // This one changes what the system does — the holder audits unprompted,
  // spending tokens nobody asked for — so granting it needs more than the
  // permission to type in a text box, and two holders in one repository would
  // mean two of them doing that.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repo = await invitableRepository(owner, "audited");
  const channel = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/agents`;

  // An ordinary role is unrestricted, as before.
  const ordinary = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "Backend Engineer" },
  });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data));

  // The owner may promote one agent to auditor.
  const promoted = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.data));

  // A second agent cannot also hold it.
  const second = await owner.request(`${channel}/openai`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(second.status, 409, JSON.stringify(second.data));
  assert.equal(second.data.error.code, "auditor_exists");

  // Re-asserting it on the agent that already holds it is not a conflict:
  // saving the same row again must not become an error.
  const again = await owner.request(`${channel}/anthropic`, {
    method: "POST",
    body: { role: "auditor" },
  });
  assert.equal(again.status, 200, JSON.stringify(again.data));

  // And the reservation cannot be walked around with a capital letter.
  const shouted = await owner.request(`${channel}/openai`, {
    method: "POST",
    body: { role: "  Auditor " },
  });
  assert.equal(shouted.status, 409, JSON.stringify(shouted.data));
});

test("a bootstrap token survives the whitespace pasting adds to it", async (t) => {
  // The token is copied out of a hosting provider's variable editor and
  // pasted into a form. Both boxes attract a trailing newline, neither shows
  // it, and the comparison used to fail on it — while the startup length
  // check trimmed first, so a server configured with a trailing newline
  // started happily and then rejected the very token it was configured with.
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": `  ${BOOTSTRAP_TOKEN}\t ` },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));

  // Still not a way in for a token that is merely close.
  const wrong = new TestClient(runtime.origin);
  const refused = await wrong.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": `${BOOTSTRAP_TOKEN}x` },
    body: {
      email: "other@example.com",
      displayName: "Other",
      password: PASSWORD,
      organizationName: "Nope",
    },
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "invalid_bootstrap_token");
});

test("a gateway configured with a padded token still starts and accepts it", async (t) => {
  // The other half: the padding is on the *server's* value, which is what a
  // pasted `COORD_BOOTSTRAP_TOKEN` actually looks like.
  const store = new InMemoryCoordinationStore();
  const gateway = new ApiGateway({
    store,
    operations: { async createRepository() { throw new Error("unused"); } } as unknown as ApiOperations,
    bootstrapToken: `${BOOTSTRAP_TOKEN}\n`,
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
  const client = new TestClient(`http://127.0.0.1:${address.port}`);
  const response = await client.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    body: {
      email: "owner@example.com",
      displayName: "Owner",
      password: PASSWORD,
      organizationName: "Relay Test",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
});
