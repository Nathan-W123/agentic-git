/** The gateway over HTTP: stopping, pausing, questions, reverts and message edits. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeTaskState,
  looksLikeTaskRequest,
} from "./server.js";
import {
  TestClient,
  addColleague,
  agentSpeech,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  joinRepository,
  registerAccount,
  startRuntime,
  waitFor,
  work,
} from "./test-harness.js";
import {
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";

test("a landed conversational task is described as done, not as open", () => {
  assert.match(describeTaskState("open"), /^done\b/u);
  assert.match(describeTaskState("integrated"), /^done\b/u);
  // The word itself must not survive into the sentence: it is the whole bug.
  assert.doesNotMatch(describeTaskState("open"), /^open$/u);

  // And the states that genuinely are not finished must not read as done.
  for (const status of ["submitted", "claimed", "planned", "failed", "cancelled"]) {
    assert.doesNotMatch(
      describeTaskState(status),
      /^done\b/u,
      `${status} must not be reported as finished`,
    );
  }
  // A status this function has not been taught is passed through rather than
  // guessed at: a wrong plain-English gloss would be worse than the raw word.
  assert.equal(describeTaskState("something_new"), "something_new");
});

test("a reply to an agent's own ending is answered, not swallowed", async (t) => {
  // Reported as "if I send an additional message in a thread the agent never
  // responds". A task that ends without being thread-worthy — the ordinary
  // one-file change whose account fits in a sentence — has its ending posted
  // as a top-level channel message of kind `outcome`, authored by the agent.
  // The dashboard offers a reply on every message, so replying to an agent's
  // last visible word opened a thread the server classified as a conversation
  // between people, and every follow-up was stored and answered by nobody.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "outcome-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    // The kind the gateway itself writes for a task that ended quietly.
    kind: "outcome",
    authorId: `${ownerId}:anthropic`,
    content: "Renamed the helper and updated its one caller. (1 file changed)",
  });

  runtime.chatAnswer.text = "Yes — it was only used in the one place.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "did anything else use it?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { id: string; replies: unknown[] }[])
      .find((message) => message.id === root.id);
    const replies = (thread?.replies ?? []) as Array<{
      authorId: string;
      kind: string;
    }>;
    // The agent answers in its own voice, in its own thread, and finishes the
    // streamed turn rather than satisfying this wait with its progress line.
    return replies.some(
      (reply) =>
        reply.authorId === `${ownerId}:anthropic` && reply.kind === "outcome",
    );
  }, "the agent never answered a reply to its own outcome message");
});

test("a reply to an agent's thread naming nobody is told why, not ignored", async (t) => {
  // The other half: a root an agent produced but that resolves to no reachable
  // agent must still say something. Storing a reply and returning silently is
  // indistinguishable, from the outside, from the product being broken.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unowned-thread-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // Kind `user`, but carrying a task — so it is work somebody is following,
  // not a standup note between people.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: bootstrapped.user.id,
    content: "Tracking the migration here.",
    taskId: "task_missing",
  });

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "any progress?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { id: string; replies: unknown[] }[])
      .find((message) => message.id === root.id);
    return ((thread?.replies ?? []) as unknown[]).length > 1;
  }, "a reply on a task thread nobody owns was stored with no explanation");
});

test("/stop cancels an agent's work and undoes only what that task promoted", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "stop-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  // Work that already reached canonical, recorded the way a promotion is.
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "a".repeat(40),
      revision: "b".repeat(40),
      files: ["src/retry.ts"],
    },
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop" },
  });
  assert.equal(posted.status, 201);

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
  }, "/stop did not cancel the in-flight task");

  const rolled = runtime.rollbacks.at(-1);
  assert.ok(rolled, "/stop did not ask for the task's changes to be undone");
  // Back to the revision before this task, and scoped to its own files — not a
  // whole-tree revert that would take other agents' work with it.
  assert.equal(rolled.targetRevision, "a".repeat(40));
  assert.deepEqual([...(rolled.files ?? [])], ["src/retry.ts"]);
});

test("/stop on a task that changed nothing cancels without a rollback", async (t) => {
  // The ordinary case: work only reaches canonical at settlement, so a task
  // stopped while running has nothing to put back and must not ask for one.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "stop-clean-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "look at the flaky test",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const before = runtime.rollbacks.length;

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop" },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
  }, "/stop did not cancel the task");
  assert.equal(
    runtime.rollbacks.length,
    before,
    "a task that promoted nothing must not trigger a rollback",
  );
});

test("pausing a task parks it, and playing it puts the same work back", async (t) => {
  // The thread header's transport control, end to end. What it must not be
  // is a cancel wearing a different glyph: the row has to come back, and the
  // same task has to be the one that runs again.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "pausable");

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rewrite the importer",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
    conversationId: "thread-root",
  });

  const paused = await owner.request(`/api/v1/tasks/${task.id}/pause`, {
    method: "POST",
    body: {},
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.task.status, "paused");
  assert.deepEqual(
    runtime.pauseCalls.map((call) => call.taskIds),
    [[task.id]],
  );
  assert.equal(runtime.pauseCalls[0]?.actorId, ownerId);
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "paused",
  );

  const runsBefore = runtime.runCalls.length;
  const resumed = await owner.request(`/api/v1/tasks/${task.id}/resume`, {
    method: "POST",
    body: {},
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.task.status, "submitted");
  assert.deepEqual(
    runtime.resumeCalls.map((call) => call.taskId),
    [task.id],
  );
  // Queueing the row is only half of resuming: something has to come and run
  // it, or play would leave the work sitting exactly as paused as before.
  await waitFor(
    async () => runtime.runCalls.length > runsBefore,
    "resuming did not start the repository's work again",
  );
  // The same task, not a new one — resuming must not fork the work.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).length,
    1,
  );
});

test("pausing and resuming write nothing into the thread", async (t) => {
  // The control is a button that changes face. A line under it saying it was
  // pressed is the app narrating its own chrome back at the person using it,
  // and two of them — one for the stop, one for the start — turn a thread
  // about the work into a thread about the buttons.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "quiet-pause");

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "@Claude rewrite the importer",
  });
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rewrite the importer",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
    conversationId: root.id,
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);

  const threadReplies = async (): Promise<string[]> => {
    const stored = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (stored?.replies ?? []).map((reply) => reply.content);
  };

  assert.equal(
    (await owner.request(`/api/v1/tasks/${task.id}/pause`, {
      method: "POST",
      body: {},
    })).status,
    200,
  );
  assert.deepEqual(await threadReplies(), []);

  const runsBefore = runtime.runCalls.length;
  assert.equal(
    (await owner.request(`/api/v1/tasks/${task.id}/resume`, {
      method: "POST",
      body: {},
    })).status,
    200,
  );
  // Resume's last act is kicking the repository, so waiting on that is
  // waiting for everything the resume does — including anything it might
  // have written.
  await waitFor(
    async () => runtime.runCalls.length > runsBefore,
    "resuming did not start the repository's work again",
  );
  assert.deepEqual(
    await threadReplies(),
    [],
    "the transport control narrated itself into the thread",
  );
});

test("a new message in a thread stops its paused task", async (t) => {
  // Pause keeps the work; saying the next thing replaces it. Without the
  // second half a redirected thread keeps a play button over an instruction
  // that has been superseded, and pressing it later puts two runs on one
  // thread answering two different questions.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "superseded-pause");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const openThread = async (
    content: string,
    objective: string,
  ): Promise<{ rootId: string; taskId: string }> => {
    const root = await runtime.store.appendChannelMessage({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      kind: "user",
      authorId: ownerId,
      content,
    });
    const task = await runtime.store.submitTask({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      objective,
      agentId: "anthropic",
      validationCommands: [],
      submittedBy: ownerId,
      conversationId: root.id,
    });
    await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);
    assert.equal(
      (await owner.request(`/api/v1/tasks/${task.id}/pause`, {
        method: "POST",
        body: {},
      })).status,
      200,
    );
    return { rootId: root.id, taskId: task.id };
  };

  const spoken = await openThread(
    "@Claude rewrite the importer",
    "rewrite the importer",
  );
  // A second parked thread nobody goes back to, which is the whole of the
  // other half: a pause is only reversible if it survives being ignored.
  const untouched = await openThread(
    "@Claude tidy the fixtures",
    "tidy the fixtures",
  );

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(spoken.rootId)}/replies`,
    { method: "POST", body: { content: "actually, leave the importer alone" } },
  );
  assert.equal(replied.status, 201);

  const statusOf = async (taskId: string): Promise<string | undefined> =>
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === taskId,
    )?.status;
  await waitFor(
    async () => (await statusOf(spoken.taskId)) === "cancelled",
    "a reply into a paused thread left the superseded run parked",
  );
  assert.ok(
    runtime.cancelCalls.some((call) => call.taskIds?.includes(spoken.taskId)),
    `the stop never reached the operation: ${JSON.stringify(runtime.cancelCalls)}`,
  );
  assert.equal(
    await statusOf(untouched.taskId),
    "paused",
    "a thread nobody replied in lost its pause",
  );
  // And it says nothing about it. The person is looking at the message they
  // just sent; an obituary for the one it replaced is noise in front of it.
  const stored = await runtime.store.getChannelMessage(
    repositoryId,
    spoken.rootId,
    ownerId,
  );
  for (const reply of stored?.replies ?? []) {
    assert.doesNotMatch(
      reply.content,
      /cancel|stopped|paused/iu,
      `the supersede narrated itself: ${reply.content}`,
    );
  }
});

test("pausing finished work is refused, and so is resuming what is not paused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unpausable");

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "already done",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: bootstrapped.user.id,
  });

  // Resuming work that is merely queued would put a play button over
  // something that is already going to run.
  const early = await owner.request(`/api/v1/tasks/${task.id}/resume`, {
    method: "POST",
    body: {},
  });
  assert.equal(early.status, 409);

  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.completeSubmittedTask(task.id, "integrated");
  const late = await owner.request(`/api/v1/tasks/${task.id}/pause`, {
    method: "POST",
    body: {},
  });
  // A pause that races the task's own ending is ordinary, and answering 200
  // would leave a play button standing over work that finished.
  assert.equal(late.status, 409);
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "integrated",
  );
});

test("pausing somebody else's project is refused like every other task action", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "guarded-pause");
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "not yours",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: bootstrapped.user.id,
  });

  const stranger = new TestClient(runtime.origin);
  await registerAccount(runtime.store, stranger, {
    email: "stranger-pause@example.com",
    displayName: "Stranger",
    password: "correct horse battery staple",
  });
  const refused = await stranger.request(`/api/v1/tasks/${task.id}/pause`, {
    method: "POST",
    body: {},
  });
  // The same authorization every task action runs through — a new verb on the
  // route is a new way in if it is not guarded like the old ones.
  assert.ok(
    refused.status === 403 || refused.status === 404,
    `pausing another tenant's task answered ${refused.status}`,
  );
  assert.deepEqual(runtime.pauseCalls, []);
});

test("'/cancel' in the channel stops the room's work and says so", async (t) => {
  // The failure mode this exists for: agents running, and nothing a person
  // could type that reached them. The channel verb has to stop the work AND
  // say what it stopped — a silent stop is indistinguishable from a stop
  // that never happened.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repo = await invitableRepository(owner, "stoppable");

  const first = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "first job",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: session.user.id,
  });
  const second = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "second job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: session.user.id,
  });

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "/cancel" } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repo,
      session.user.id,
    );
    return messages.some((message) =>
      message.content.includes("Stopped 2 queued tasks in this channel."),
    );
  }, "the channel never reported the stop");

  assert.equal(runtime.cancelCalls.length, 1);
  assert.equal(runtime.cancelCalls[0]?.actorId, session.user.id);
  assert.equal(runtime.cancelCalls[0]?.vendor, undefined);
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(first.id), "cancelled");
  assert.equal(statuses.get(second.id), "cancelled");
});

test("'/cancel @agent' stops that agent's work and nobody else's", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "scoped-stop");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  const codexTask = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "codex job",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const claudeTask = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });

  const posted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `/cancel @${mention}` } },
  );
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes(`Stopped 1 queued task for @${mention}.`),
    );
  }, "the channel never reported the scoped stop");

  assert.equal(runtime.cancelCalls[0]?.vendor, "codex");
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(codexTask.id), "cancelled");
  assert.equal(statuses.get(claudeTask.id), "submitted");
});

test("'/stop @agent' spares another persona's same-vendor work", async (t) => {
  // The reported bug: two personas run the same vendor CLI, so both resolve
  // to the same configured agent id — and a vendor-scoped stop swept both.
  // A persona is the (owner, vendor) pair, and the stop must honour it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "persona-stop");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const colleague = await addColleague(runtime, "persona-stop@example.com");
  runtime.chatConnections.set(colleague.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  assert.equal(
    (
      await owner.request(`${base}/agents/anthropic`, {
        method: "POST",
        body: { name: "Medea" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await colleague.client.request(`${base}/agents/${colleague.id}:anthropic`, {
        method: "POST",
        body: { name: "Andromeda" },
      })
    ).status,
    200,
  );

  const mine = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "my own claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  const theirs = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "the colleague's claude job",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: colleague.id,
  });

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/stop @Medea" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes("Stopped 1 queued task for @Medea."),
    );
  }, "the channel never reported the persona-scoped stop");

  assert.equal(runtime.cancelCalls[0]?.ownerId, ownerId);
  const statuses = new Map(
    (
      await runtime.store.listSubmittedTasks({ repositoryId: repo })
    ).map((task) => [task.id, task.status]),
  );
  assert.equal(statuses.get(mine.id), "cancelled");
  // The other persona's task is untouched — same vendor, different person.
  assert.equal(statuses.get(theirs.id), "submitted");
});

test("'/cancel' for a name nobody answers to stops nothing and says who it could", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "misnamed-stop");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId: repo,
    objective: "still wanted",
    agentId: "test-agent-codex",
    validationCommands: [],
    submittedBy: ownerId,
  });

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: "/cancel @Nobody" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.content.includes('Nobody here answers to "Nobody"'),
    );
  }, "the channel never explained the unknown name");

  assert.equal(runtime.cancelCalls.length, 0);
  const [row] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.equal(row?.id, task.id);
  assert.equal(row?.status, "submitted");
});

test("a reply naming an option routes back to the waiting question", async (t) => {
  // The round trip the owner could not verify: "1" typed in the thread must
  // reach the paused coordinator as a chosen index, not as conversation.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked-and-answered");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never became work",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.notEqual(task, undefined);

  // The request message is the thread the question will be asked in.
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never attached the task to its request");
  const root = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.taskId === task?.id);
  assert.notEqual(root, undefined);

  const waiting = runtime.gateway.awaitAgentAnswer({
    requestId: "q-route",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    deadlineMs: 4_000,
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) => reply.content.includes("Which approach?")),
    );
  }, "the question never reached the thread");

  const replied = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${root?.id}/replies`,
    { method: "POST", body: { content: "1" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  // The set comes back one answer per question, and `chosen` still mirrors the
  // first of them for an adapter that only ever asks one thing.
  assert.deepEqual(await waiting, { chosen: 0, answers: [{ chosen: 0 }] });
});

test("a set of questions is answered from the prompt, not from the thread", async (t) => {
  // The prompt above the composer is where a question is answered now. It is
  // put to the person who submitted the task and to nobody else, it carries
  // every question at once, and the options never appear in the transcript —
  // a numbered list in a message cannot page, cannot mark a recommendation,
  // and cannot take an answer the agent did not think of.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "asked-in-prompt");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never became work",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never attached the task to its request");

  const waiting = runtime.gateway.awaitAgentAnswer({
    requestId: "q-set",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    questions: [
      {
        question: "Which approach?",
        options: ["Both modules", "One and a shim"],
        recommended: 1,
      },
      { question: "Keep the old name?", options: ["Keep", "Rename"] },
      { question: "Add a test?", options: ["Yes", "No"] },
    ],
    deadlineMs: 4_000,
  });

  const questionsPath = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/questions`;
  await waitFor(async () => {
    const answer = await owner.request(questionsPath);
    return (answer.data?.questions ?? []).length > 0;
  }, "the question never reached the person who asked for the work");
  const listed = (await owner.request(questionsPath)).data;
  assert.equal(listed.questions[0].requestId, "q-set");
  assert.equal(listed.questions[0].questions.length, 3);
  assert.equal(listed.questions[0].questions[0].recommended, 1);

  // The thread records that a question was asked without repeating its
  // choices: the same decision open in two places could be taken twice.
  const messages = await runtime.store.listChannelMessages(repo, ownerId);
  const posted = messages
    .flatMap((message) => message.replies)
    .map((reply) => reply.content)
    .filter((content) => content.includes("Which approach?"));
  assert.equal(posted.length, 1);
  assert.equal(
    posted.filter((content) => content.includes("1. Both modules")).length,
    0,
  );

  const answered = await owner.request(
    `${questionsPath}/q-set/answer`,
    {
      method: "POST",
      body: {
        answers: [{ chosen: 1 }, { text: "call it loader2" }, {}],
      },
    },
  );
  assert.equal(answered.status, 200, JSON.stringify(answered.data));

  // One answer per question, in order, and an empty one is a deliberate pass
  // rather than a gap the agent has to interpret.
  assert.deepEqual(await waiting, {
    chosen: 1,
    answers: [{ chosen: 1 }, { text: "call it loader2" }, { skipped: true }],
  });

  // And once settled it is gone: a question is a live wait, so there is
  // nothing left to answer twice.
  const after = await owner.request(questionsPath);
  assert.deepEqual(after.data.questions, []);
});

test("an answer after the deadline is told it was late, not chatted at", async (t) => {
  // The undiagnosable half of the incident: the owner answered "1", nothing
  // happened, and nothing recorded whether the reply failed to route or the
  // question had already cancelled. Now the late reply gets the account.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "answered-late");
  runtime.chatConnections.set(ownerId, [
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";
  const mention = `Codex (${String(session.user.displayName).split(" ")[0]})`;

  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages`,
    { method: "POST", body: { content: `@${mention} please fix the retry loop` } },
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never became work",
  );
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) => message.taskId === task?.id);
  }, "the dispatch never attached the task to its request");
  const root = (
    await runtime.store.listChannelMessages(repo, ownerId)
  ).find((message) => message.taskId === task?.id);

  // The deadline lapses with nobody answering.
  const lapsed = await runtime.gateway.awaitAgentAnswer({
    requestId: "q-late",
    taskId: task?.id ?? "",
    repositoryId: repo,
    projectId: DEFAULT_PROJECT_ID,
    question: "Which approach?",
    options: ["Both modules", "One and a shim"],
    deadlineMs: 30,
  });
  assert.equal(lapsed, undefined);

  // The answer arrives late — the exact shape of the incident.
  await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel/messages/${root?.id}/replies`,
    { method: "POST", body: { content: "1" } },
  );

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(repo, ownerId);
    return messages.some((message) =>
      message.replies.some((reply) =>
        reply.content.includes("after the question's deadline"),
      ),
    );
  }, "the late answer was never told what happened to it");
  // And it never fell through to the chat model as a question about "1".
  assert.equal(
    runtime.chatPrompts.filter((entry) => entry.prompt.includes("The question: 1"))
      .length,
    0,
  );
});

test("the task root and acknowledgement exist immediately", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "fast-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  // Slower than anyone will wait, and far slower than the thread may take.
  // The opening thoughts still use a completion, but dispatch does not.
  runtime.chatAnswer.delayMs = 1_500;
  runtime.chatAnswer.text = "Picking this up — reading the retry loop first.";

  // Measured across the POST, because the route awaits the whole dispatch —
  // so anything the dispatch waits for is time the browser spends blocked
  // before it can render anything at all.
  const startedAt = Date.now();
  const request = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  const posted = Date.now() - startedAt;

  const listed = await owner.request(`${base}/messages`);
  assert.ok(
    (listed.data.messages as { id: string; kind: string; taskId?: string }[]).some(
      (message) =>
        message.id === request.data.message.id &&
        message.kind === "user" &&
        message.taskId !== undefined,
    ),
    "the posted request was not made the task root",
  );
  // No completion's worth of waiting: opening thoughts run behind the response.
  assert.ok(
    posted < 1_000,
    `posting waited ${String(posted)}ms — it is still blocked on a model call`,
  );

  const root = (listed.data.messages as any[]).find(
    (message) => message.id === request.data.message.id,
  );
  const acknowledgement = (root?.replies ?? []).find(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(
    acknowledgement?.content,
    "I've taken this task and I'm working on it.",
  );
  assert.ok(
    runtime.chatPrompts.every(
      (entry) => !/only the acknowledgement|picking it up/iu.test(entry.prompt),
    ),
    JSON.stringify(runtime.chatPrompts),
  );
});

test("the work is queued without waiting for opening thoughts or its local title", async (t) => {
  // The second half of the same complaint. `planOpening` is a model call
  // allowed two minutes, and the run used to start only after it returned —
  // so a thread could say it had picked something up while nothing ran.
  let releaseTitle!: (title: string) => void;
  let titleStarted = false;
  const pendingTitle = new Promise<string>((resolve) => {
    releaseTitle = resolve;
  });
  const runtime = await startRuntime(t, {
    threadTitleSummariser: async () => {
      titleStarted = true;
      return await pendingTitle;
    },
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "fast-start-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  runtime.chatAnswer.delayMs = 1_500;
  runtime.chatAnswer.text = "On it.";

  const startedAt = Date.now();
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  await waitFor(
    async () => runtime.runCalls.length > 0,
    "the repository was never asked to run",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "starting the work waited on a model call rather than on none",
  );
  assert.equal(titleStarted, true);
  const beforeTitle = await owner.request(`${base}/messages`);
  assert.equal(
    (beforeTitle.data.messages as any[]).some((message) =>
      (message.replies ?? []).some((reply: any) => /^Task: /u.test(reply.content)),
    ),
    false,
  );

  releaseTitle("Retry loop reliability");
  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    return (listed.data.messages as any[]).some((message) =>
      (message.replies ?? []).some(
        (reply: any) => reply.content === "Task: Retry loop reliability",
      ),
    );
  }, "the completed local title was not attached asynchronously");
});

test("an image in a request reaches the agent as a file it can open", async (t) => {
  // The point of attaching one. The channel writes `![alt](attachment:<id>)`,
  // which the dashboard turns into an <img> and an agent could only read as
  // punctuation — so the objective names the path instead, and the bytes are
  // already on the filesystem the task runs on.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "attachment-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  const id = "a".repeat(32) + ".png";
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: `@${name} fix the header spacing to match this ![screenshot](attachment:${id})`,
    },
  });

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  // The path the stub answers with, not the upload id.
  assert.match(task!.objective, /\/attachments\/a{32}\.png/u);
  assert.match(task!.objective, /open this file to see it/u);
  // And the markdown is gone, because an agent cannot do anything with it.
  assert.doesNotMatch(task!.objective, /attachment:/u);
});

test("an image the deployment cannot place is left as it was written", async (t) => {
  // A wrong path is worse than a visible id: one is a puzzle, the other is a
  // lie about a file. An unknown id keeps its reference.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "attachment-missing-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  const missing = "b".repeat(32) + ".png";
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: `@${name} update the button styling to match ![gone](attachment:${missing})`,
    },
  });

  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.match(task!.objective, /attachment:b{32}\.png/u);
});

test("a thread opens while the agent is working, not once it has finished", async (t) => {
  // Reported as: threads do not appear until the task completes, which is
  // backwards for a room whose purpose is watching the work happen. The agent's
  // own progress message is the first thing about *this* run rather than about
  // every run, so it is what opens the thread — and the held preamble flushes
  // in above it.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "live-thread-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: `@${name} rework the retry loop` },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });

  // The run says what it is doing. Nothing has ended.
  await runtime.store.appendAudit(undefined, {
    type: "agent_progress",
    taskId: task!.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      message: "Reading retry.ts and mapping every caller",
    },
  });

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as { taskId?: string; replies: unknown[] }[])
      .find((message) => message.taskId === task!.id);
    const replies = (thread?.replies ?? []) as { content: string }[];
    return replies.some((reply) => reply.content.includes("mapping every caller"));
  }, "the thread stayed empty while the agent was working");
});

test("asking about work is not asking for it", () => {
  // The verb list carries past tenses — "changed", "fixed", "updated" — so a
  // question about work already done matched it and was dispatched as new
  // work. In a thread that meant checking out the repository and running a
  // whole task to answer three words, on somebody's own account.
  for (const question of [
    "which key changed?",
    "what did you fix?",
    "which files were updated?",
    "why was the retry loop removed?",
    "has anyone updated the readme?",
    "how are the pullout icons animated?",
    "what is its default?",
  ]) {
    assert.equal(looksLikeTaskRequest(question), false, question);
  }

  // A question mark is grammar, not intent. Everything here still dispatches:
  // the polite interrogatives are imperatives, the last is a question with a
  // request stapled to it, and "handle" is present tense in a sentence that
  // asks for nothing already done.
  for (const request of [
    "can you fix the retry loop?",
    "could you add a hello to the readme?",
    "would you rename the auth module?",
    "please update the readme",
    "fix the login bug",
    "why not just delete that file?",
    "did you see the bug? fix it",
    "which key changed, and can you revert it?",
    "when toggling this pullout the icons should be animated from the arrow",
    // Plain instruction verbs. Every one of these was missed, which is how a
    // request could name exactly what it wanted and still not read as work:
    // the sender was answered rather than obeyed, and had to write "make that
    // implementation" — one recognised word — to get it done.
    'For the signin page instead of it saying kumi just put the logo and get rid of the punchline "one live codebase.."',
    "put the logo on the sign in page",
    "get rid of the punchline",
    "hide the punchline",
    "drop the subtitle from the header",
    "take out the old banner",
    "turn off the animation",
    "shrink the sidebar",
  ]) {
    assert.equal(looksLikeTaskRequest(request), true, request);
  }

  // The other direction, kept beside it: widening the verb list must not turn
  // chatter or a question about finished work into a task. "show" and "use"
  // are deliberately still absent — "show me a summary of the codebase" is an
  // answer request, and a task verb wins over that test, so adding them would
  // trade this bug for its mirror image.
  for (const notWork of [
    "show me a summary of the codebase",
    "give me an overview of the auth module",
    "what did you get rid of?",
    "which files were dropped?",
  ]) {
    assert.equal(looksLikeTaskRequest(notWork), false, notWork);
  }
});

/**
 * Work handed to the room without naming anybody.
 *
 * "any takers for the flaky auth ticket?" is a real ask, and a task-verb
 * list missed every one of these because "own", "takers" and "a hand"
 * describe delegation rather than the repository operation. Nothing decides
 * this by phrasing any more — the agent reads the sentence — so what has to
 * hold is that these reach it at all, which is asserted against the real
 * model in `packages/local-triage`, and that the agent's answer is what
 * dispatches. This pins the second half.
 */
test("an open-room request is picked up without anybody being named", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "open-room");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  runtime.setTaskClassification("ACT");
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "any takers for the flaky auth ticket?" },
    })).status,
    201,
  );

  assert.equal(
    runtime.submittedTasks.length,
    1,
    JSON.stringify(runtime.submittedTasks),
  );
  assert.match(
    String(runtime.submittedTasks[0]?.objective),
    /flaky auth ticket/u,
  );
});

test("/stop names one agent even with words after the name", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "stop-named");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  // An agent nobody has renamed is "Claude (Nathan)" — a space and a bracket
  // inside the name, which is exactly what a first-word split would lose.
  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;

  // Each of these is one person saying "stop that agent". Matching the whole
  // remainder against the roster meant everything but the bare name found
  // nobody and stopped nothing, while saying so in the channel.
  for (const [index, rest] of [
    `@${mention}`,
    `@${mention} please`,
    `@${mention}, that's wrong`,
  ].entries()) {
    const task = await runtime.store.submitTask({
      repositoryId,
      projectId: DEFAULT_PROJECT_ID,
      objective: `rework number ${index}`,
      // The fixture's `cancelTasks` matches a vendor-scoped stop against
      // `test-agent-<vendor>`; a name-targeted stop resolves to the claude
      // vendor, so this is the agent it has to be looking for.
      agentId: "test-agent-claude",
      validationCommands: [],
      submittedBy: ownerId,
    });
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `/stop ${rest}` },
    });
    assert.equal(posted.status, 201, rest);
    await waitFor(async () => {
      const listed = await runtime.store.listSubmittedTasks({ repositoryId });
      return listed.find((entry) => entry.id === task.id)?.status === "cancelled";
    }, `"/stop ${rest}" did not stop the named agent`);
  }

  const said = (await owner.request(`${base}/messages`)).data.messages
    .map((message: any) => String(message.content))
    .join("\n");
  assert.doesNotMatch(said, /Nobody here answers/u);
});

test("a message the agent reads as chatter is answered with silence", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "not-a-request");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Every one of these is about work and asks for none. They are read — that
  // is the point of reading rather than matching — and the agent's answer is
  // to say nothing, which has to mean nothing: no offer, no task, no line in
  // the room.
  runtime.setTaskClassification("IGNORE");
  for (const remark of [
    "the retry loop was rewritten last week",
    "I updated the readme this morning",
    "we should probably refactor this at some point",
    "that migration broke the build yesterday",
  ]) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    });
    assert.equal(posted.status, 201, remark);
  }
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(agentSpeech(after.data.messages), []);
});

test("a revert reports that it worked, and takes the thread's file list back with it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "revert-files");
  const landed = "b".repeat(40);
  const before = "a".repeat(40);

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: before,
      revision: landed,
      files: ["src/retry.ts"],
    },
  });
  runtime.canonicalState.head = landed;
  // What the summary backfill rebuilds from. Without this the durability
  // assertion below passes whether or not the revert is respected, because
  // there would be nothing to rebuild the list out of.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      changedFiles: [{ path: "src/retry.ts", status: "modified" }],
    },
  });

  // The thread this work was narrated in, carrying the file summary a reader
  // sees under it.
  const thread = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, thread.id, task.id);
  await runtime.store.setChannelMessageChangedFiles(repositoryId, thread.id, [
    { path: "src/retry.ts", status: "modified" },
  ]);

  const reverted = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/rollback`,
    { method: "POST", body: { taskId: task.id } },
  );
  assert.equal(reverted.status, 200, JSON.stringify(reverted.data));
  // The one status that means it happened. Everything else — conflict,
  // validation_failed, stale, empty — is a revert that did not.
  assert.equal(reverted.data.rollback.status, "integrated");
  // Back to the state before this task, not to some other revision.
  assert.equal(runtime.rollbacks.at(-1)?.targetRevision, before);

  // And the thread stops claiming the file it no longer changes. The stores
  // normalise an empty list to "nothing recorded", so this reads back as
  // absent rather than as an empty array.
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    thread.id,
    ownerId,
  );
  assert.equal(after?.changedFiles, undefined);

  // And it stays gone across a channel read. A thread with no file list is
  // what the summary backfill goes looking for, and the events it rebuilds
  // from are the very ones this revert undid.
  //
  // Honest about its own strength: the backfill needs line counts this
  // fixture cannot produce, so it currently writes nothing here either way —
  // disabling the `task_reverted` guard does not fail this assertion. It is a
  // regression guard, not a proof: if the rebuild ever starts working in this
  // fixture, or somebody removes the guard *and* fixes the counts, the file
  // comes back and this catches it.
  const listed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`,
  );
  assert.equal(listed.status, 200);
  const rebuilt = (listed.data.messages as any[]).find(
    (message) => message.id === thread.id,
  );
  assert.equal(
    rebuilt?.changedFiles ?? undefined,
    undefined,
    JSON.stringify(rebuilt?.changedFiles),
  );
});

test("a revert that fails validation is not reported as one that worked", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "revert-refused");
  const landed = "d".repeat(40);

  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "anthropic",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.appendAudit(undefined, {
    type: "canonical_promoted",
    taskId: task.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      previousRevision: "c".repeat(40),
      revision: landed,
      files: ["src/retry.ts"],
    },
  });
  runtime.canonicalState.head = landed;

  const thread = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, thread.id, task.id);
  await runtime.store.setChannelMessageChangedFiles(repositoryId, thread.id, [
    { path: "src/retry.ts", status: "modified" },
  ]);

  runtime.setRollbackOutcome({
    status: "validation_failed",
    explanation: "The tests do not pass on the older tree",
  });
  const refused = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/rollback`,
    { method: "POST", body: { taskId: task.id } },
  );
  assert.equal(refused.status, 200);
  assert.equal(refused.data.rollback.status, "validation_failed");

  // Nothing was put back, so the thread still reports what this task changed.
  // Clearing it here would tell a reader the files are safe when they are not.
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    thread.id,
    ownerId,
  );
  assert.deepEqual(after?.changedFiles, [
    { path: "src/retry.ts", status: "modified" },
  ]);
});

test("the agent reads the message before auto-dispatching, and no means no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "reads-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Half the work vocabulary is also ordinary nouns, so no word list tells
  // "update the readme" from "the update went out". These clear the free
  // checks and are still not requests; the agent that would take them is
  // asked, and says no.
  runtime.setTaskClassification("no");
  const before = runtime.chatPrompts.length;
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "please update the settings page layout" },
  });
  assert.equal(posted.status, 201);

  // It was read — one prompt, and it asked the question this gate asks.
  const asked = runtime.chatPrompts.slice(before);
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.match(
    String(asked[0]?.prompt),
    /Reply with exactly one of these three lines/u,
  );
  assert.match(String(asked[0]?.prompt), /settings page layout/u);

  // And nothing was said or started.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(agentSpeech(after.data.messages), []);
  assert.deepEqual(
    (after.data.messages as any[]).filter((message) =>
      /Want me to take this/u.test(String(message.content)),
    ),
    [],
  );
});

test("every unaddressed message is read, whatever words it uses", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "free-checks-first");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // A word list used to answer for these without asking anybody, and it had
  // to: "Changes look good" opens with a word from the verb list and is a
  // person saying the changes look good. But the same list also answered for
  // "the gray background looks rough" — silence — and for "the update went
  // out" — a request. It cannot do better, because the difference is not in
  // the words. So every message is read now, and the agent decides.
  const remarks = [
    "Changes have been made and look good",
    "Changes look good",
    "Yo what's up",
    "the update went out this morning",
    "the build is fixed now",
  ];
  runtime.setTaskClassification("IGNORE");
  const before = runtime.chatPrompts.length;
  for (const remark of remarks) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: remark },
    });
    assert.equal(posted.status, 201, remark);
  }

  const asked = runtime.chatPrompts.slice(before);
  assert.equal(
    asked.length,
    remarks.length,
    `each message reaches the agent: ${JSON.stringify(asked.map((entry) => entry.prompt.slice(-60)))}`,
  );
  for (const remark of remarks) {
    assert.ok(
      asked.some((entry) => entry.prompt.endsWith(remark)),
      `"${remark}" was read`,
    );
  }
  // And read is not the same as acted on. Every one of them was answered
  // with silence.
  assert.equal(runtime.submittedTasks.length, 0);
  const after = await owner.request(`${base}/messages`);
  assert.deepEqual(agentSpeech(after.data.messages), []);
});

test("a thread opens on the request that caused it, in the words it was asked in", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-opener");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";
  const asked = `@${name} rework the retry loop`;

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: asked },
  });
  await waitFor(async () => {
    const listed = await runtime.store.listSubmittedTasks({ repositoryId });
    return listed.length > 0;
  }, "the mention never became a task");
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });

  // The handoff reply exists before any task-specific narration.
  const beforeNarration = await owner.request(`${base}/messages`);
  const quiet = (beforeNarration.data.messages as any[]).find(
    (message) => message.taskId === task!.id,
  );
  assert.equal(quiet?.kind, "user");
  assert.equal(quiet?.content, asked);
  const quietSpeech = (quiet?.replies ?? []).filter(
    (reply: any) => reply.kind === "agent",
  );
  assert.equal(quietSpeech.length, 1);
  assert.equal(
    quietSpeech[0]?.content,
    "I've taken this task and I'm working on it.",
  );

  await runtime.store.appendAudit(undefined, {
    type: "agent_progress",
    taskId: task!.id,
    data: {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      message: "Reading retry.ts and mapping every caller",
    },
  });

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as any[]).find(
      (message) => message.taskId === task!.id,
    );
    return ((thread?.replies ?? []) as any[]).some((reply) =>
      String(reply.content).includes("mapping every caller"),
    );
  }, "the run never narrated");

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.taskId === task!.id,
  );
  const replies = (thread?.replies ?? []) as any[];
  // The root itself is the person's exact request; its replies begin with the
  // handoff and continue with narration.
  assert.equal(thread?.kind, "user");
  assert.equal(thread?.content, asked);
  assert.equal(thread?.authorId, ownerId);
  assert.ok(replies.length > 0, JSON.stringify(replies));
  assert.equal(
    replies.filter((reply) => reply.kind === "agent").length,
    1,
    JSON.stringify(replies),
  );
});

test("work merged into an existing thread says what asked for it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-merge-opener");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // A thread that already exists, with a task hanging off it.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  const agents = await owner.request(`${base}/agents`);
  const name = (agents.data.agents as { name: string }[])[0]?.name ?? "";
  const asked = `@${name} and also raise the retry ceiling`;

  await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: asked } },
  );

  // Asked inside the thread, so it is a reply and is in there by definition —
  // the dispatch must not post a second copy of it.
  await waitFor(async () => {
    const thread = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (thread?.replies ?? []).some(
      (reply) => reply.content === asked && reply.kind === "user",
    );
  }, "the request never landed in the thread");
  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  assert.equal(
    (thread?.replies ?? []).filter((reply) => reply.content === asked).length,
    1,
    JSON.stringify(thread?.replies),
  );
});

test("channel messages and replies can be corrected only before anyone acts on them", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "message-edit");
  const guest = await joinRepository(
    runtime,
    owner,
    "edit-guest@example.com",
    repositoryId,
  );
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`;

  const posted = await owner.request(base, {
    method: "POST",
    body: { content: "Meet at tree o'clock." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  const notAuthors = await guest.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "I should not be able to rewrite this." },
  });
  assert.equal(notAuthors.status, 403, JSON.stringify(notAuthors.data));

  const corrected = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "Meet at three o'clock." },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.message.content, "Meet at three o'clock.");
  assert.equal(
    (
      await runtime.store.getChannelMessage(
        repositoryId,
        messageId,
        session.user.id,
      )
    )?.content,
    "Meet at three o'clock.",
  );

  await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: "agent:test",
    content: "That time works.",
    referencedMessageId: messageId,
  });
  const alreadyAnswered = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "Meet at four o'clock." },
  });
  assert.equal(alreadyAnswered.status, 409, JSON.stringify(alreadyAnswered.data));

  const reply = await runtime.store.addChannelReply({
    repositoryId,
    messageId,
    kind: "user",
    authorId: session.user.id,
    content: "A first reply.",
  });
  const replyCorrected = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "A corrected reply." } },
  );
  assert.equal(replyCorrected.status, 200, JSON.stringify(replyCorrected.data));
  assert.equal(replyCorrected.data.reply.content, "A corrected reply.");

  await runtime.store.addChannelReply({
    repositoryId,
    messageId,
    kind: "user",
    authorId: session.user.id,
    content: "This answers the corrected reply.",
    referencedMessageId: reply.id,
  });
  const replyAnswered = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "Too late to rewrite this reply." } },
  );
  assert.equal(replyAnswered.status, 409, JSON.stringify(replyAnswered.data));

  // Once the root has a reply, changing the visible request would rewrite
  // history underneath somebody who has already acted on it.
  const answered = await owner.request(`${base}/${messageId}`, {
    method: "PATCH",
    body: { content: "A different request entirely." },
  });
  assert.equal(answered.status, 409, JSON.stringify(answered.data));

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    objective: "act on the reply",
    agentId: "test-agent",
    validationCommands: [],
    submittedBy: session.user.id,
  });
  await runtime.store.setChannelMessageTask(repositoryId, messageId, task.id);
  const agentStarted = await owner.request(
    `${base}/${messageId}/replies/${reply.id}`,
    { method: "PATCH", body: { content: "Too late to change the prompt." } },
  );
  assert.equal(agentStarted.status, 409, JSON.stringify(agentStarted.data));
});

test("deleting your own channel message removes it, and somebody else's does not", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "deletable");
  const guest = await joinRepository(
    runtime,
    owner,
    "guest@example.com",
    repositoryId,
  );
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await guest.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A thought, quickly regretted." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const messageId = posted.data.message.id;

  // The guest is a developer: in the room, and no reach over anybody else's
  // words in it. The owner's line is the owner's to unsay.
  const owners = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "The owner's own line." },
  });
  const guestTryingOwners = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${owners.data.message.id}`,
    { method: "DELETE" },
  );
  assert.equal(
    guestTryingOwners.status,
    403,
    JSON.stringify(guestTryingOwners.data),
  );

  // The author's own goes outright — nothing hangs off it.
  const removed = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.redacted, false);
  assert.equal(removed.data.cancelledTask, false);
  assert.equal(
    await runtime.store.getChannelMessage(
      repositoryId,
      messageId,
      session.user.id,
    ),
    undefined,
  );

  // Gone is gone: a second delete has nothing to find.
  const again = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(again.status, 404, JSON.stringify(again.data));

  // And a manager reaches anybody's — the other half of the rule.
  const guestsSecond = await guest.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Something for a moderator to remove." },
  });
  const moderated = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${guestsSecond.data.message.id}`,
    { method: "DELETE" },
  );
  assert.equal(moderated.status, 200, JSON.stringify(moderated.data));
  assert.equal(
    await runtime.store.getChannelMessage(
      repositoryId,
      guestsSecond.data.message.id,
      session.user.id,
    ),
    undefined,
  );
});

test("deleting a message that carries a thread blanks it and stops its task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repositoryId = await invitableRepository(owner, "thread-delete");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Rename the config key everywhere." },
  });
  const messageId = posted.data.message.id;
  const reply = await owner.request(
    `${base}/messages/${messageId}/replies`,
    { method: "POST", body: { content: "On it." } },
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.data));

  const task = await runtime.store.submitTask({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    objective: "rename the config key",
    agentId: "test-agent-claude",
    validationCommands: [],
    submittedBy: ownerId,
  });
  await runtime.store.setChannelMessageTask(repositoryId, messageId, task.id);

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  // Blanked rather than removed: the reply under it is somebody's reading.
  assert.equal(removed.data.redacted, true);
  assert.equal(removed.data.removed, 0);
  // And the work it asked for was stopped, because the message was the ask.
  assert.equal(removed.data.cancelledTask, true);
  assert.equal(
    runtime.cancelCalls.some((call) => call.taskIds?.includes(task.id)),
    true,
    JSON.stringify(runtime.cancelCalls),
  );

  const tombstone = await runtime.store.getChannelMessage(
    repositoryId,
    messageId,
    ownerId,
  );
  assert.equal(tombstone?.content, "");
  assert.ok(tombstone?.deletedAt !== undefined);
  assert.equal(tombstone?.deletedBy, ownerId);
  assert.equal(
    (tombstone?.replies ?? []).some(
      (entry) => entry.id === reply.data.reply.id,
    ),
    true,
  );

  // The reply is its own decision, and its own delete. The tombstone stays:
  // the two are separate rows and separate asks.
  const replyGone = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${messageId}/replies/${reply.data.reply.id}`,
    { method: "DELETE" },
  );
  assert.equal(replyGone.status, 200, JSON.stringify(replyGone.data));
  const after = await runtime.store.getChannelMessage(
    repositoryId,
    messageId,
    ownerId,
  );
  assert.equal(
    (after?.replies ?? []).some((entry) => entry.id === reply.data.reply.id),
    false,
  );
  assert.ok(after?.deletedAt !== undefined);

  // `?purge=1` is the thread panel's own delete: the whole thread goes,
  // replies included, which is what that button has always promised.
  const second = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "A second thread." },
  });
  const secondId = second.data.message.id;
  await owner.request(`${base}/messages/${secondId}/replies`, {
    method: "POST",
    body: { content: "With something under it." },
  });
  const purged = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages/${secondId}?purge=1`,
    { method: "DELETE" },
  );
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  assert.equal(purged.data.redacted, false);
  assert.equal(
    await runtime.store.getChannelMessage(repositoryId, secondId, ownerId),
    undefined,
  );
});

test("a direct message can be edited by its sender and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dm-edit");
  const guest = await joinRepository(
    runtime,
    owner,
    "dm-edit-guest@example.com",
    repositoryId,
  );
  const guestId = (await guest.request("/api/v1/auth/me")).data.user.id;

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}`,
    { method: "POST", body: { content: "Meet at tree." } },
  );
  const messageId = sent.data.message.id;
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/messages/${messageId}`,
    { method: "PATCH", body: { content: "Not my words." } },
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.data));

  const corrected = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}/messages/${messageId}`,
    { method: "PATCH", body: { content: "Meet at three." } },
  );
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.message.content, "Meet at three.");
  assert.equal(
    (
      await runtime.store.listDirectMessages(
        DEFAULT_PROJECT_ID,
        guestId,
        session.user.id,
      )
    )[0]?.content,
    "Meet at three.",
  );
});

test("a direct message can be unsent by its sender and nobody else", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dm-delete");
  const guest = await joinRepository(
    runtime,
    owner,
    "dm-guest@example.com",
    repositoryId,
  );
  const guestId = (await guest.request("/api/v1/auth/me")).data.user.id;

  const sent = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}`,
    { method: "POST", body: { content: "Sent too soon." } },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const messageId = sent.data.message.id;

  // The recipient cannot unsend what they did not send.
  const refused = await guest.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${session.user.id}/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.data));

  const removed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/direct-messages/${guestId}/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  // Gone for both sides, because both sides are the whole audience.
  assert.deepEqual(
    await runtime.store.listDirectMessages(
      DEFAULT_PROJECT_ID,
      guestId,
      session.user.id,
    ),
    [],
  );
});
