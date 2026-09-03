/** The gateway over HTTP: the remote-worker protocol, metrics and catch-up. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
} from "./auth.js";
import {
  PASSWORD,
  TestClient,
  bearer,
  bootstrap,
  invitableRepository,
  rawHttp,
  startRuntime,
  work,
  workerRuntime,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("a worker registers, leases exclusively, and heartbeats", async (t) => {
  const { runtime, token } = await workerRuntime(t);

  const registered = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "worker-a", adapters: ["codex"], version: "1.0.0" },
  });
  assert.equal(registered.status, 201);
  const workerId = registered.data.id as string;

  const unscoped = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    { method: "POST", body: { workerId } },
  );
  assert.equal(unscoped.status, 400);

  // Nothing queued yet, so the poll must say so without a body.
  const empty = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(empty.status, 204);

  await runtime.store.saveRepository({
    id: "repo_worker",
    path: "/canonical/worker.git",
    branch: "main",
  });
  const task = await runtime.store.submitTask({
    repositoryId: "repo_worker",
    objective: "cap the value",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  assert.equal(leased.data.task.id, task.id);
  assert.equal(leased.data.lease.status, "active");
  assert.ok(leased.data.bundleUrl.includes(leased.data.lease.id));

  // A second poll finds nothing: the task is exclusively held.
  const second = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(second.status, 204);

  const beat = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(beat.status, 200);
  assert.ok(beat.data.expiresAt > leased.data.lease.expiresAt);
});

test("releasing a lease returns the task to the queue", async (t) => {
  const { runtime, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_release",
    path: "/canonical/release.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_release",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  const released = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/release`,
    token,
    { method: "POST" },
  );
  assert.equal(released.status, 200);

  // Another poll now finds the work again.
  const relet = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(relet.status, 200);

  // A heartbeat on the abandoned lease must be refused, not silently accepted.
  const stale = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leased.data.lease.id}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "lease_lost");
});

test("a task whose worker died stops being served as one still running", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: {
        organizationId: DEFAULT_ORGANIZATION_ID,
        name: "w",
        adapters: [],
        version: "1",
      },
    })
  ).data.id as string;

  await client.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories`, {
    method: "POST",
    body: { id: "repo_sweep", branch: "main" },
  });
  await client.request(`/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`, {
    method: "POST",
    body: { repositoryId: "repo_sweep", objective: "work on it" },
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200, JSON.stringify(leased.data));
  const leaseId = leased.data.lease.id as string;

  // A live lease is untouched: reading the list must not reclaim work from a
  // worker that is still holding it.
  const held = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(held.data.tasks[0].status, "claimed");

  // The worker dies. Its lease lapses where it lies, and every other caller
  // that would expire one is itself a worker route — so with the worker gone,
  // nothing ran, and the task stayed `claimed` forever. Everything that reads
  // it, from the browser's working dot to a status report, then said an agent
  // was running work that had stopped.
  await runtime.store.heartbeatWorkLease(
    leaseId,
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:01:00.000Z",
  );

  const after = await client.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(after.status, 200);
  assert.equal(
    after.data.tasks[0].status,
    "submitted",
    "a lapsed lease should return its task to the queue before it is listed",
  );
  assert.equal((await runtime.store.getWorkLease(leaseId))?.status, "expired");
});

test("worker endpoints require the run_task scope", async (t) => {
  const { runtime, client } = await workerRuntime(t);
  const readOnly = await client.request("/api/v1/auth/tokens", {
    method: "POST",
    body: { name: "read-only", scopes: ["view"] },
  });
  const token = readOnly.data.token as string;

  const denied = await bearer(runtime.origin, "/api/v1/workers/register", token, {
    method: "POST",
    body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, "token_scope_missing");
});

test("malformed hosts and encoded paths stay inside the HTTP error boundary", async (t) => {
  const runtime = await startRuntime(t);
  const hostResponse = await rawHttp(
    runtime.port,
    "GET /api/v1/health HTTP/1.1\r\n" +
      "Host: [malformed\r\n" +
      "Connection: close\r\n\r\n",
  );
  assert.match(hostResponse, /^HTTP\/1\.1 200 /u);

  const client = new TestClient(runtime.origin);
  await bootstrap(client);
  const malformedPath = await client.request("/api/v1/projects/%E0%A4%A");
  assert.equal(malformedPath.status, 400);
  assert.equal(malformedPath.data.error.code, "invalid_path");

  const healthy = await client.request("/api/v1/health");
  assert.equal(healthy.status, 200);
});

test("project metrics are served to members and refused across tenants", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const metrics = await owner.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.projectId, "project_local");

  // A signed-in user with no membership in the project's organization gets
  // the same generic refusal as for any other project-scoped resource.
  const outsiderUser = await runtime.store.createUser({
    email: "metrics-outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const outsider = new TestClient(runtime.origin);
  await outsider.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: outsiderUser.email, password: PASSWORD },
  });
  const denied = await outsider.request(
    "/api/v1/projects/project_local/metrics",
  );
  assert.equal(denied.status, 403);
});

test("the catch-up says what changed while somebody was away, then clears", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "catch-up-repo");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  // Nobody's first sign-in has a "while you were away": handing somebody the
  // project's whole history the first time they arrive is not catching them
  // up on anything. It starts their clock instead, or the second visit would
  // have nothing to measure from either.
  const first = await owner.request(catchUpPath);
  assert.equal(first.status, 200);
  assert.equal(first.data.catchUp.empty, true);
  assert.deepEqual(first.data.catchUp.lines, []);
  assert.notEqual(
    await runtime.store.getCatchUpCursor(DEFAULT_PROJECT_ID, ownerId),
    undefined,
  );

  // Somebody who was here yesterday and has been away since.
  const colleague = await runtime.store.createUser({
    email: "catch-up-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );

  await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "pushed the retry fix",
  });
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "Fix the retry loop",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendDirectMessage({
    projectId: DEFAULT_PROJECT_ID,
    authorId: ownerId,
    recipientId: colleague.id,
    content: "have a look when you are back",
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(caught.data.catchUp.empty, false);
  assert.equal(
    caught.data.catchUp.headline,
    "1 change landed while you were away",
  );
  // Landed work is named; everything else is counted, which is the whole
  // difference between this and reading the channel again.
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Fix the retry loop", "1 new message", "1 unread direct message"],
  );
  assert.deepEqual(caught.data.catchUp.counts, {
    landed: 1,
    failed: 0,
    messages: 1,
    direct: 1,
  });
  // No local model answered here, so the prose is the deterministic wording —
  // the headline and the same lines, which is what a deployment without a
  // model shows.
  assert.equal(
    caught.data.catchUp.summary,
    [
      "1 change landed while you were away",
      "• Fix the retry loop",
      "• 1 new message",
      "• 1 unread direct message",
    ].join("\n"),
  );

  // Saying it has been read is its own call, so a popup that never rendered
  // does not silently swallow the news.
  const seen = await client.request(`${catchUpPath}/seen`, { method: "POST" });
  assert.equal(seen.status, 200);
  assert.ok(seen.data.seenAt > caught.data.catchUp.since);

  const again = await client.request(catchUpPath);
  assert.equal(again.data.catchUp.empty, true);
});

test("the local model writes the catch-up's prose, and only its prose", async (t) => {
  const prompts: string[] = [];
  const runtime = await startRuntime(t, {
    catchUpSummariser: async (prompt) => {
      prompts.push(prompt);
      return prompt.includes("User request:")
        ? "Fixed the retry loop and verified the recovery path."
        : "Somebody fixed the retry loop while you were out.";
    },
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "catch-up-summarised");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  const colleague = await runtime.store.createUser({
    email: "catch-up-reader@example.com",
    displayName: "Reader",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "Fix the retry loop",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      agentExplanation: "Raised the retry limit and added recovery coverage.",
      files: ["retry.ts", "retry.test.ts"],
    },
  });

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(
    caught.data.catchUp.summary,
    "Somebody fixed the retry loop while you were out.",
  );
  // The model was handed the facts, not asked to go and find them.
  assert.ok((prompts[0] ?? "").includes("Fix the retry loop"), prompts[0]);
  const taskPrompt =
    prompts.find((prompt) => prompt.includes("User request:")) ?? "";
  assert.match(taskPrompt, /Fix the retry loop/u);
  assert.match(taskPrompt, /Raised the retry limit and added recovery coverage/u);
  assert.equal(caught.data.catchUp.tasks[0]?.id, task.id);
  assert.equal(caught.data.catchUp.tasks[0]?.repositoryId, repositoryId);
  assert.equal(
    caught.data.catchUp.tasks[0]?.summary,
    "Fixed the retry loop and verified the recovery path.",
  );
  assert.deepEqual(
    caught.data.catchUp.tasks[0]?.changedFiles,
    ["retry.ts", "retry.test.ts"],
  );
  // And it rewrote only the prose: the list and the counts are still the
  // measured ones, so a wrong sentence cannot become a wrong catch-up.
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Fix the retry loop"],
  );
  assert.deepEqual(caught.data.catchUp.counts, {
    landed: 1,
    failed: 0,
    messages: 0,
    direct: 0,
  });
  assert.equal(
    caught.data.catchUp.headline,
    "1 change landed while you were away",
  );
});

test("a conversational turn that landed is described, not left to its prompt", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "catch-up-open-thread");
  const catchUpPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`;

  const colleague = await runtime.store.createUser({
    email: "catch-up-thread-reader@example.com",
    displayName: "Reader",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: DEFAULT_ORGANIZATION_ID,
    userId: colleague.id,
    role: "developer",
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    colleague.id,
    "2026-01-01T00:00:00.000Z",
  );

  // Work asked for inside a thread lands and then waits for the next message,
  // so its row stays `open` and never gets a `completedAt`. Skipping those
  // left the client with nothing but the request to caption them with.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "can you fix the notification on the bottom left",
    agentId: "claude",
    validationCommands: [],
    conversationId: "conversation-1",
  });
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      agentExplanation:
        "The unread count now sits on the avatar instead of floating away from it.",
      files: ["app.js"],
    },
  });
  await runtime.store.openSubmittedTask(task.id);

  const client = new TestClient(runtime.origin);
  await client.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const caught = await client.request(catchUpPath);
  assert.equal(caught.status, 200);
  assert.equal(caught.data.catchUp.tasks.length, 1);
  assert.equal(caught.data.catchUp.tasks[0]?.id, task.id);
  assert.equal(
    caught.data.catchUp.tasks[0]?.summary,
    "The unread count now sits on the avatar instead of floating away from it.",
  );
  assert.deepEqual(caught.data.catchUp.tasks[0]?.changedFiles, ["app.js"]);
  assert.equal(caught.data.catchUp.counts.landed, 1);
});

test("a catch-up carries only what its reader may see", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const granted = await invitableRepository(owner, "catch-up-granted");
  const hidden = await invitableRepository(owner, "catch-up-hidden");

  // Reached through a per-repository grant and no organization role: the
  // catch-up has to narrow the same way the repository list does, or it
  // becomes a way to read the activity of a repository nobody shared.
  const guest = await runtime.store.createUser({
    email: "catch-up-guest@example.com",
    displayName: "Guest",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: granted,
    userId: guest.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  await runtime.store.markCatchUpSeen(
    DEFAULT_PROJECT_ID,
    guest.id,
    "2026-01-01T00:00:00.000Z",
  );
  for (const [repositoryId, objective] of [
    [granted, "Shared work"],
    [hidden, "Work behind a wall"],
  ] as const) {
    const task = await runtime.store.submitTask({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      objective,
      agentId: "codex",
      validationCommands: [],
    });
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
    await runtime.store.completeSubmittedTask(task.id, "integrated");
  }

  const guestClient = new TestClient(runtime.origin);
  await guestClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: guest.email, password: PASSWORD },
  });
  const caught = await guestClient.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`,
  );
  assert.equal(caught.status, 200);
  assert.deepEqual(
    caught.data.catchUp.lines.map((line: { text: string }) => line.text),
    ["Shared work"],
  );

  // Somebody with no membership and no grant is refused, as they are for
  // every other project-scoped route.
  const outsider = await runtime.store.createUser({
    email: "catch-up-outsider@example.com",
    displayName: "Outsider",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const stranger = new TestClient(runtime.origin);
  await stranger.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: outsider.email, password: PASSWORD },
  });
  const denied = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up`,
  );
  assert.equal(denied.status, 403);
  const deniedSeen = await stranger.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/catch-up/seen`,
    { method: "POST" },
  );
  assert.equal(deniedSeen.status, 403);
});

test("muting a channel silences it for one person and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const noisy = await invitableRepository(owner, "mute-noisy");
  const quiet = await invitableRepository(owner, "mute-quiet");
  const mutesPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/channel/mutes`;
  const mutePath = (repositoryId: string) =>
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/mute`;

  const before = await owner.request(mutesPath);
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.repositoryIds, []);

  const muted = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(muted.status, 200);
  assert.equal(muted.data.muted, true);
  const after = await owner.request(mutesPath);
  assert.deepEqual(after.data.repositoryIds, [noisy]);

  // Somebody else in the same rooms hears them exactly as before: a mute is a
  // preference, not a property of the channel.
  const colleague = await runtime.store.createUser({
    email: "mute-colleague@example.com",
    displayName: "Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveRepositoryGrant({
    repositoryId: noisy,
    userId: colleague.id,
    role: "developer",
    grantedBy: bootstrapped.user.id,
    comped: false,
    createdAt: new Date().toISOString(),
  });
  const colleagueClient = new TestClient(runtime.origin);
  await colleagueClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: colleague.email, password: PASSWORD },
  });
  const theirs = await colleagueClient.request(mutesPath);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.data.repositoryIds, []);

  // A grant holder is told about their own mutes on the repositories they can
  // see, and never about one they cannot.
  await colleagueClient.request(mutePath(noisy), {
    method: "POST",
    body: { muted: true },
  });
  // The same answer a repository that does not exist gets: somebody who
  // reaches this project through one grant is not told what else is in it.
  const refused = await colleagueClient.request(mutePath(quiet), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(refused.status, 404);
  const narrowed = await colleagueClient.request(mutesPath);
  assert.deepEqual(narrowed.data.repositoryIds, [noisy]);

  // Unmuting is the same call the other way round, and the owner's own list
  // is untouched by anything the colleague did.
  const unmuted = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: false },
  });
  assert.equal(unmuted.status, 200);
  assert.equal(unmuted.data.muted, false);
  assert.deepEqual((await owner.request(mutesPath)).data.repositoryIds, []);
  assert.deepEqual(
    (await colleagueClient.request(mutesPath)).data.repositoryIds,
    [noisy],
  );

  // The flag has to be a boolean: an absent or misspelled one would otherwise
  // read as "unmute" and quietly undo somebody's setting.
  const malformed = await owner.request(mutePath(noisy), {
    method: "POST",
    body: { muted: "yes" },
  });
  assert.equal(malformed.status, 400);
  const missing = await owner.request(mutePath("repo_does_not_exist"), {
    method: "POST",
    body: { muted: true },
  });
  assert.equal(missing.status, 404);

  const stranger = new TestClient(runtime.origin);
  assert.equal((await stranger.request(mutesPath)).status, 401);
});

test("project policy is validated, stored, and clearable through the API", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const invalid = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: { version: 2 } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, "invalid_policy");

  const policy = {
    version: 1,
    approvals: { requireChangesetReview: true, protectedPaths: ["infra/**"] },
  };
  const set = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.project.policy, policy);
  const fetched = await owner.request("/api/v1/projects/project_local");
  assert.deepEqual(fetched.data.project.policy, policy);

  const cleared = await owner.request("/api/v1/projects/project_local", {
    method: "PATCH",
    body: { policy: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.project.policy, undefined);
});

test("configured browser origins receive credentialed CORS and preflight", async (t) => {
  const allowedOrigin = "https://relay-client.example";
  const runtime = await startRuntime(t, {
    allowedOrigins: [allowedOrigin],
  });
  const preflight = await fetch(`${runtime.origin}/api/v1/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /POST/u,
  );
  assert.equal(
    preflight.headers.get("access-control-allow-credentials"),
    "true",
  );

  const allowed = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );

  const denied = await fetch(`${runtime.origin}/api/v1/health`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("a project-bound worker token cannot pull another tenant's queue", async (t) => {
  const { runtime } = await workerRuntime(t);
  const firstOrganization = await runtime.store.createOrganization({
    slug: "worker-first",
    name: "Worker First",
  });
  const secondOrganization = await runtime.store.createOrganization({
    slug: "worker-second",
    name: "Worker Second",
  });
  // These are made straight through the store, which every production path
  // that creates an organization now does alongside writing a subscription
  // row — a missing row is no entitlement, so without this both tenants fold
  // to `viewer` and the test measures the billing gate rather than the tenant
  // boundary it is about.
  for (const organization of [firstOrganization, secondOrganization]) {
    await runtime.store.saveSubscription({
      organizationId: organization.id,
      status: "comped",
    });
  }
  const firstProject = await runtime.store.createProject({
    organizationId: firstOrganization.id,
    slug: "first",
    name: "First",
  });
  const secondProject = await runtime.store.createProject({
    organizationId: secondOrganization.id,
    slug: "second",
    name: "Second",
  });
  const developer = await runtime.store.createUser({
    email: "fleet-developer@example.com",
    displayName: "Fleet Developer",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: firstOrganization.id,
    userId: developer.id,
    role: "developer",
  });
  const developerClient = new TestClient(runtime.origin);
  await developerClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: developer.email, password: PASSWORD },
  });
  const issued = await developerClient.request("/api/v1/auth/tokens", {
    method: "POST",
    body: {
      name: "tenant-worker",
      scopes: ["view", "run_task"],
      organizationId: firstOrganization.id,
    },
  });
  const token = issued.data.token as string;
  const worker = await bearer(
    runtime.origin,
    "/api/v1/workers/register",
    token,
    {
      method: "POST",
      body: {
        organizationId: firstOrganization.id,
        name: "tenant-worker",
        adapters: ["codex"],
        version: "1",
      },
    },
  );
  assert.equal(worker.status, 201);

  // A colleague's worker in the same organization. Fleet visibility is
  // org-wide, so this one must be visible to the developer even though they
  // did not register it.
  const colleague = await runtime.store.createUser({
    email: "colleague@example.com",
    displayName: "Colleague",
    passwordDigest: "unused",
  });
  await runtime.store.saveMembership({
    organizationId: firstOrganization.id,
    userId: colleague.id,
    role: "developer",
  });
  const colleagueWorker = await runtime.store.registerWorker({
    userId: colleague.id,
    organizationId: firstOrganization.id,
    name: "colleague-worker",
    adapters: ["codex"],
    version: "1",
  });

  // A worker in a different organization. Widening visibility within a tenant
  // must not widen it across one.
  const outsider = await runtime.store.createUser({
    email: "other-fleet@example.com",
    displayName: "Other Fleet",
    passwordDigest: "unused",
  });
  await runtime.store.registerWorker({
    userId: outsider.id,
    organizationId: secondOrganization.id,
    name: "other-worker",
    adapters: ["codex"],
    version: "1",
  });

  const visibleWorkers = await bearer(
    runtime.origin,
    `/api/v1/workers?organizationId=${firstOrganization.id}`,
    token,
  );
  assert.equal(visibleWorkers.status, 200);
  assert.deepEqual(
    visibleWorkers.data.workers
      .map((entry: { id: string }) => entry.id)
      .sort(),
    [worker.data.id, colleagueWorker.id].sort(),
  );
  // The colleague's worker is visible but not drivable: `own` is what the UI
  // uses to distinguish the two, and it must not be true here.
  assert.equal(
    visibleWorkers.data.workers.find(
      (entry: { id: string }) => entry.id === colleagueWorker.id,
    ).own,
    false,
  );

  // Naming the other tenant is refused outright rather than answered with an
  // empty list, and refused by the token binding before membership is even
  // consulted.
  const crossTenantFleet = await bearer(
    runtime.origin,
    `/api/v1/workers?organizationId=${secondOrganization.id}`,
    token,
  );
  assert.equal(crossTenantFleet.status, 403);
  assert.equal(crossTenantFleet.data.error.code, "token_organization_mismatch");

  await runtime.store.saveRepository({
    id: "repo_other_tenant",
    path: "/canonical/other-tenant.git",
    branch: "main",
  });
  await runtime.store.linkRepository(
    secondProject.id,
    "repo_other_tenant",
  );
  await runtime.store.submitTask({
    projectId: secondProject.id,
    repositoryId: "repo_other_tenant",
    objective: "private objective",
    agentId: "codex",
    validationCommands: [],
  });

  const ownQueue = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: firstProject.id,
      },
    },
  );
  assert.equal(ownQueue.status, 204);

  const crossTenant = await bearer(
    runtime.origin,
    "/api/v1/workers/leases",
    token,
    {
      method: "POST",
      body: {
        workerId: worker.data.id,
        projectId: secondProject.id,
      },
    },
  );
  assert.equal(crossTenant.status, 403);
  assert.equal(crossTenant.data.error.code, "token_organization_mismatch");
  assert.equal(
    (await runtime.store.listSubmittedTasks({ projectId: secondProject.id }))[0]
      ?.status,
    "submitted",
  );
});

/**
 * The fleet boundary, proved on the membership path rather than the token one.
 *
 * The neighbouring test authenticates with a token bound to one organization,
 * so it is refused by the credential's own binding before membership is ever
 * consulted. That check is worth having but it is not the boundary: a cookie
 * session carries no binding at all, so the only thing standing between a
 * signed-in user and another tenant's fleet is the membership lookup. This
 * test drives that path deliberately, and asserts the widening and the limit
 * together — seeing a colleague's worker and being refused a stranger's are
 * the same query differing only in which organization was named.
 */
test("org-wide worker visibility stops at the organization boundary", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);

  const alpha = await runtime.store.createOrganization({
    slug: "alpha",
    name: "Alpha",
  });
  const beta = await runtime.store.createOrganization({
    slug: "beta",
    name: "Beta",
  });

  // Two members of Alpha, so "org-wide" is actually exercised: one registers a
  // worker, the other must still see it.
  const alphaUser = await runtime.store.createUser({
    email: "alpha-dev@example.com",
    displayName: "Alpha Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const alphaColleague = await runtime.store.createUser({
    email: "alpha-colleague@example.com",
    displayName: "Alpha Colleague",
    passwordDigest: await hashPassword(PASSWORD),
  });
  const betaUser = await runtime.store.createUser({
    email: "beta-dev@example.com",
    displayName: "Beta Dev",
    passwordDigest: await hashPassword(PASSWORD),
  });
  for (const [organizationId, userId] of [
    [alpha.id, alphaUser.id],
    [alpha.id, alphaColleague.id],
    [beta.id, betaUser.id],
  ] as const) {
    await runtime.store.saveMembership({
      organizationId,
      userId,
      role: "developer",
    });
  }

  const alphaOwn = await runtime.store.registerWorker({
    userId: alphaUser.id,
    organizationId: alpha.id,
    name: "alpha-own",
    adapters: ["codex"],
    version: "1",
  });
  const alphaOther = await runtime.store.registerWorker({
    userId: alphaColleague.id,
    organizationId: alpha.id,
    name: "alpha-colleague",
    adapters: ["codex"],
    version: "1",
  });
  const betaWorker = await runtime.store.registerWorker({
    userId: betaUser.id,
    organizationId: beta.id,
    name: "beta-secret",
    adapters: ["codex"],
    version: "1",
  });

  const client = new TestClient(runtime.origin);
  assert.equal(
    (
      await client.request("/api/v1/auth/login", {
        method: "POST",
        body: { email: alphaUser.email, password: PASSWORD },
      })
    ).status,
    200,
  );

  // The widening: a colleague's worker, which the old per-user filter hid.
  const visible = await client.request(
    `/api/v1/workers?organizationId=${alpha.id}`,
  );
  assert.equal(visible.status, 200);
  const visibleIds = visible.data.workers
    .map((entry: { id: string }) => entry.id)
    .sort();
  assert.deepEqual(visibleIds, [alphaOwn.id, alphaOther.id].sort());

  // The limit: Beta's worker is absent from Alpha's fleet, and naming Beta is
  // refused on membership — a plain `forbidden`, with no token binding
  // involved. Both are asserted because an endpoint that leaked the row while
  // refusing the request, or refused the request while leaking the row, would
  // pass only one of them.
  assert.equal(visibleIds.includes(betaWorker.id), false);
  const refused = await client.request(
    `/api/v1/workers?organizationId=${beta.id}`,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error.code, "forbidden");

  // The counts endpoint reads the same fleet and must draw the same line;
  // a total that spans tenants reports how busy Beta is.
  const runningAlpha = await client.request(
    `/api/v1/agents/running?organizationId=${alpha.id}`,
  );
  assert.equal(runningAlpha.status, 200);
  assert.equal(runningAlpha.data.workers, 2);
  assert.equal(
    (await client.request(`/api/v1/agents/running?organizationId=${beta.id}`))
      .status,
    403,
  );

  // Naming no organization is refused rather than defaulted: an endpoint that
  // guessed a tenant would answer a request that never identified one.
  assert.equal((await client.request("/api/v1/workers")).status, 400);

  // Beta's own member sees Beta's fleet and only it, so the boundary is a
  // property of the organization asked about and not of this one user.
  const betaClient = new TestClient(runtime.origin);
  await betaClient.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: betaUser.email, password: PASSWORD },
  });
  const betaVisible = await betaClient.request(
    `/api/v1/workers?organizationId=${beta.id}`,
  );
  assert.equal(betaVisible.status, 200);
  assert.deepEqual(
    betaVisible.data.workers.map((entry: { id: string }) => entry.id),
    [betaWorker.id],
  );
  assert.equal(
    (
      await betaClient.request(
        `/api/v1/workers?organizationId=${alpha.id}`,
      )
    ).status,
    403,
  );
});

test("a task past its runtime budget is failed at heartbeat", async (t) => {
  const { runtime, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "budgeted", adapters: [], version: "1" },
    })
  ).data.id as string;
  await runtime.store.saveRepository({
    id: "repo_budget",
    path: "/canonical/budget.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_budget",
    objective: "long-running objective",
    agentId: "codex",
    validationCommands: [],
  });
  await runtime.store.updateProject(DEFAULT_PROJECT_ID, {
    policy: { version: 1, budgets: { maxTaskRuntimeMs: 1 } },
  });

  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });
  assert.equal(leased.status, 200);
  const leaseId = leased.data.lease.id as string;

  await new Promise((resolve) => setTimeout(resolve, 20));
  const beat = await bearer(
    runtime.origin,
    `/api/v1/workers/leases/${leaseId}/heartbeat`,
    token,
    { method: "POST" },
  );
  assert.equal(beat.status, 409);
  assert.equal(beat.data.error.code, "budget_exceeded");

  // Failed, not requeued: rerunning the same runaway task would just burn
  // the budget again.
  assert.equal((await runtime.store.getWorkLease(leaseId))?.status, "failed");
  assert.equal(
    (await runtime.store.listSubmittedTasks())[0]?.status,
    "failed",
  );
  const audit = await runtime.store.listAudit();
  assert.ok(
    audit.some(
      (event) =>
        event.type === "task_failed" &&
        event.data["stage"] === "budget_enforcement",
    ),
  );
});

test("a worker cannot touch another user's lease", async (t) => {
  const { runtime, client, token } = await workerRuntime(t);
  const workerId = (
    await bearer(runtime.origin, "/api/v1/workers/register", token, {
      method: "POST",
      body: { organizationId: DEFAULT_ORGANIZATION_ID, name: "w", adapters: [], version: "1" },
    })
  ).data.id as string;

  await runtime.store.saveRepository({
    id: "repo_iso",
    path: "/canonical/iso.git",
    branch: "main",
  });
  await runtime.store.submitTask({
    repositoryId: "repo_iso",
    objective: "objective",
    agentId: "codex",
    validationCommands: [],
  });
  const leased = await bearer(runtime.origin, "/api/v1/workers/leases", token, {
    method: "POST",
    body: { workerId, projectId: DEFAULT_PROJECT_ID },
  });

  // A second tenant with a perfectly valid run_task token.
  const intruderUser = await runtime.store.createUser({
    email: "intruder@example.com",
    displayName: "Intruder",
    passwordDigest: await hashPassword(PASSWORD),
  });
  await runtime.store.saveMembership({
    organizationId: "org_local",
    userId: intruderUser.id,
    role: "developer",
  });
  const intruder = new TestClient(runtime.origin);
  await intruder.request("/api/v1/auth/login", {
    method: "POST",
    body: { email: "intruder@example.com", password: PASSWORD },
  });
  const intruderToken = (
    await intruder.request("/api/v1/auth/tokens", {
      method: "POST",
      body: { name: "theirs", scopes: ["view", "run_task"] },
    })
  ).data.token as string;

  for (const action of ["heartbeat", "release", "result"]) {
    const response = await bearer(
      runtime.origin,
      `/api/v1/workers/leases/${leased.data.lease.id}/${action}`,
      intruderToken,
      { method: "POST", body: { status: "failed" } },
    );
    assert.equal(response.status, 404, action);
  }
});

test("a member's agent colour is readable by the colleagues it identifies", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const setup = await bootstrap(owner);

  const chosen = await owner.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accent: "#4F8EF7", agentColor: "#E05F9E" },
  });
  assert.equal(chosen.status, 200);
  // Normalised on the way in, so two spellings of one colour compare equal.
  assert.equal(chosen.data.user.appearance.agentColor, "#e05f9e");
  assert.equal(chosen.data.user.appearance.accent, "#4f8ef7");

  const me = await owner.request("/api/v1/auth/me");
  assert.equal(me.data.user.appearance.agentColor, "#e05f9e");

  // The point of the colour is that other people can read it: a teammate
  // listing the organization's members has to see it, or "pink doodles are
  // Nathan's agents" is not a thing anyone can learn.
  const members = await owner.request(
    `/api/v1/organizations/${DEFAULT_ORGANIZATION_ID}/members`,
  );
  assert.equal(members.status, 200);
  const listed = members.data.members.find(
    (member: any) => member.userId === setup.user.id,
  );
  assert.equal(listed.user.appearance.agentColor, "#e05f9e");
});

test("changing one colour leaves the others alone", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accent: "#2fae7f" },
  });
  await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { accentSecondary: "#D7A13B" },
  });
  // A PATCH names only what it changes; the colours picked a moment ago must
  // survive a later choice of agent colour. Three of them now, and each is
  // written by its own wheel, so one wheel must not clear the other two.
  const third = await client.request("/api/v1/auth/me/appearance", {
    method: "PATCH",
    body: { agentColor: "#e05f9e" },
  });
  assert.equal(third.status, 200);
  assert.deepEqual(third.data.user.appearance, {
    accent: "#2fae7f",
    accentSecondary: "#d7a13b",
    agentColor: "#e05f9e",
  });
});

test("an agent colour must be a plain hex triple", async (t) => {
  const runtime = await startRuntime(t);
  const client = new TestClient(runtime.origin);
  await bootstrap(client);

  // The value is written into a style attribute, so a CSS colour that happens
  // to carry a second declaration must not survive the edge. Every colour
  // field, not just the agent one: they all reach a style attribute, and a
  // field that skipped the check would be the one somebody found.
  for (const field of ["accent", "accentSecondary", "agentColor"]) {
    for (const value of [
      "red;background:url(https://x)",
      "rgb(1,2,3)",
      "#fff",
      "javascript:alert(1)",
    ]) {
      const rejected = await client.request("/api/v1/auth/me/appearance", {
        method: "PATCH",
        body: { [field]: value },
      });
      assert.equal(rejected.status, 400, `${field}: ${value} should be refused`);
    }
  }
});
