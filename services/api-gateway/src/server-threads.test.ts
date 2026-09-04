/** The gateway over HTTP: narration, thread replies, slash commands and plans. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  explainAnswerFailure,
  looksLikeTaskRequest,
  narrateTaskEvent,
  readsAsEchoOfRequest,
  withRoleContext,
} from "./server.js";
import {
  TestClient,
  addColleague,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  startRuntime,
  waitFor,
  work,
} from "./test-harness.js";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
} from "@coord/persistence";
import {
  AGENT_ACCOUNT_PREFIX,
} from "@coord/shared-types";

test("a channel stop is not repeated by every affected agent", () => {
  assert.equal(
    narrateTaskEvent("task_cancelled", {
      reason: "Stopped from the channel",
    }),
    undefined,
  );
  assert.equal(
    narrateTaskEvent("task_cancelled", {
      reason: "Cancelled because a dependency failed",
    }),
    "This was cancelled.",
  );
});

test("a finished task says what it did, not that the pipeline worked", () => {
  // "Done — the change is in canonical." was the ending of every successful
  // task this system had ever run. It is true of all of them and says nothing
  // about any of them, so watching two tasks finish taught the reader
  // nothing — while the agent's own account of the work sat in the changeset,
  // carried all the way to promotion and never read.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation:
        "Repointed six test imports at their new modules; collection passes.",
      files: ["a.py", "b.py"],
    }),
    "Repointed six test imports at their new modules; collection passes.",
  );
  // The changed-file block already names the files. The ending is only the
  // agent's answer, regardless of how many changed files the task reports.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Raised the retry ceiling to five.",
      files: ["retry.ts"],
    }),
    "Raised the retry ceiling to five.",
  );
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Split the module.",
      files: ["a.py", "b.py", "c.py"],
    }),
    "Split the module.",
  );
  // No files recorded is not a reason to withhold the summary.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Raised the retry ceiling to five.",
    }),
    "Raised the retry ceiling to five.",
  );

  // The adapters' fallback for a model that explained nothing is the vendor
  // name and the objective handed back — and the objective is already the
  // thread's title, so that is the canned line with extra steps. Say the
  // plain thing instead of dressing it up as a summary.
  for (const written of [
    "claude completed Repair stale test imports",
    "Codex completed the objective",
    "",
    "   ",
  ]) {
    assert.equal(
      narrateTaskEvent("canonical_promoted", { agentExplanation: written }),
      "Done — the change is in canonical.",
      written,
    );
  }

  // A long account reaches the reader whole. It used to be cut back to the
  // sentences that fit inside 200 characters, which dropped the half of it
  // somebody had asked for — a diagnosis, a caveat, what was left undone —
  // with nowhere in the channel to read the rest.
  const long = narrateTaskEvent("canonical_promoted", {
    agentExplanation:
      "Your own messages now sit on the right on a phone. " +
      "Everybody else's stay on the left, and the desktop layout is " +
      "unchanged. The reader's own id decides which side a message takes, " +
      "so a signed-out reader sees every message on the left as before.",
  });
  assert.equal(
    long,
    "Your own messages now sit on the right on a phone. Everybody else's " +
      "stay on the left, and the desktop layout is unchanged. The reader's " +
      "own id decides which side a message takes, so a signed-out reader " +
      "sees every message on the left as before.",
  );
  assert.doesNotMatch(long ?? "", /…/u);

  // A paragraph — several hundred characters, far past every bound this used
  // to keep — survives byte for byte.
  const paragraph = `${"This sentence says something worth reading. ".repeat(14)}And this one ends it.`;
  assert.ok(paragraph.length > 600, String(paragraph.length));
  assert.equal(
    narrateTaskEvent("canonical_promoted", { agentExplanation: paragraph }),
    paragraph,
  );

  // A runaway wall of text used to be cut at a char bound mid-thought. Agent
  // endings are left whole now — the channel gets what the agent wrote.
  const novelBody = `${"word ".repeat(1200)}end`;
  assert.ok(novelBody.length > 4_100, String(novelBody.length));
  const novel = narrateTaskEvent("canonical_promoted", {
    agentExplanation: novelBody,
  });
  assert.equal(novel, novelBody);
  assert.doesNotMatch(novel ?? "", /…/u);

  // Newlines collapse: the ending is one line in a channel, and a multi-line
  // explanation would otherwise read as several messages.
  assert.equal(
    narrateTaskEvent("canonical_promoted", {
      agentExplanation: "Fixed the loop.\n\nAlso tidied the imports.",
    }),
    "Fixed the loop. Also tidied the imports.",
  );
});

test("agent progress reaches the channel whole, never cut mid-word", () => {
  // Progress used to be sliced at 300 characters with no ellipsis — the exact
  // cut that left answers ending on "what tech s" while the agent was still
  // thinking. The full message is the progress line.
  const message =
    "I don't see any project files in the current directory. Could you share " +
    "the app code (as a file, zip, or by pointing me to a repository) so I " +
    "can investigate the latency issues? Alternatively, if you'd like me to " +
    "set up a sample project to demonstrate latency troubleshooting, let me " +
    "know what tech stack you prefer.";
  assert.ok(message.length > 300, String(message.length));
  assert.equal(
    narrateTaskEvent("agent_progress", { message }),
    message,
  );
  assert.doesNotMatch(
    narrateTaskEvent("agent_progress", { message }) ?? "",
    /what tech s$/u,
  );
});

test("a failed task says why, whichever shape the failure was recorded in", () => {
  const integration = narrateTaskEvent("task_failed", {
    status: "policy_failed",
    explanation: "the changeset touched a protected path",
  });
  assert.match(String(integration), /policy|rules would not let/iu);
  assert.match(String(integration), /protected path/u);

  // No explanation at all still names the outcome rather than shrugging.
  assert.equal(
    narrateTaskEvent("task_failed", { status: "conflict" }),
    "I could not finish this — the change clashed with work that landed " +
      "while I was writing it, and I could not merge the two.",
  );

  // The `error` shape every other emitter uses is unchanged.
  assert.equal(
    narrateTaskEvent("task_failed", { stage: "execution", error: "boom" }),
    "I could not finish this: boom",
  );

  // An expired sign-in keeps its own remedy, and does not get an integration
  // reason bolted onto it.
  assert.match(
    String(
      narrateTaskEvent("task_failed", {
        error: "OAuth session expired and could not be refreshed",
      }),
    ),
    /sign-in has expired\. Reconnect me from Settings → Agents/u,
  );

  // The key a remote worker actually wrote, for as long as it wrote it.
  //
  // `acceptWorkResult` recorded its reason under `detail` — the one emitter of
  // six that did not use `error` or `explanation` — so every failure reported
  // by somebody's desktop reached the room as the bare sentence below, with
  // the reason sitting in the audit record under a name nothing read. On a
  // deployment that has moved execution onto people's machines that is every
  // failure there is, which is exactly how three different vendors came to
  // look equally broken.
  //
  // The emitter now writes `error`. This keeps the rows already on the record
  // able to explain themselves.
  assert.equal(
    narrateTaskEvent("task_failed", { detail: "npm test exited 1" }),
    "I could not finish this: npm test exited 1",
  );
  // And it stays last: a row carrying both is a row from the fixed emitter,
  // where `error` is the one that was meant.
  assert.equal(
    narrateTaskEvent("task_failed", { error: "boom", detail: "stale" }),
    "I could not finish this: boom",
  );
  // An expired sign-in reported by a worker still gets its remedy, which is
  // the whole point: the reader is the only person who can carry it out.
  assert.match(
    String(
      narrateTaskEvent("task_failed", {
        detail: "OAuth session expired and could not be refreshed",
      }),
    ),
    /sign-in has expired\. Reconnect me from Settings → Agents/u,
  );

  // Nothing to say at all is still the honest fallback.
  assert.equal(
    narrateTaskEvent("task_failed", {}),
    "I could not finish this.",
  );
});

/**
 * A read-only request that ends with no diff reaches the failure path with its
 * whole answer inside the failure: the coordinator appends the agent's own
 * account to the alarm rather than discarding it. Clipping that at 200
 * characters is how a channel showed "…What the URL act" and stopped — the
 * deliverable, cut mid-word, with nothing to open and read the rest in.
 */
test("a failure carrying the agent's own account keeps the account whole", () => {
  const account =
    "Diagnosis only — no files changed. Short answer: no, that URL does not " +
    "mean your pasted photos go into the codebase. What the URL actually " +
    "points at is the attachment route, which reads the bytes back out of " +
    "the attachment store; nothing on that path writes them into the " +
    "repository, so pasting a screenshot cannot bloat the checkout.";
  const said = String(
    narrateTaskEvent("task_failed", {
      status: "empty",
      explanation:
        "The agent produced no repository changes. " +
        `${AGENT_ACCOUNT_PREFIX} ${account}`,
    }),
  );
  // The alarm still leads — an empty run from a task meant to write is still
  // a failure, whatever it says for itself.
  assert.match(said, /^I could not finish this — I did not end up with any/u);
  // And the answer survives in full, unclipped and unbroken.
  assert.ok(said.includes(account), said);
  assert.doesNotMatch(said, /…/u);
});

test("a clipped failure detail still ends on a whole word", () => {
  // A bare slice cut mid-word, which reads as a model that stopped
  // mid-thought rather than as a quotation somebody shortened.
  const detail = Array.from({ length: 200 }, (_, index) => `token${index}`).join(
    " ",
  );
  const said = explainAnswerFailure(detail);
  assert.match(said, /…$/u);
  const quoted = said
    .replace("I could not answer that just now: ", "")
    .replace(/…$/u, "")
    .trim();
  for (const word of quoted.split(" ")) {
    assert.match(word, /^token\d+$/u, said);
  }
});

test("a refused GitHub push keeps GitHub's remedy, not the agent's", () => {
  // The push path fails in GitHub's name when the *submitter's* token is
  // refused. It speaks the same auth vocabulary — "401", "unauthorized" —
  // but reconnecting an agent is the wrong door: it sends somebody
  // off to reconnect an agent that is working fine, while the actual fix
  // lives in Settings → GitHub and the failure's own words point there.
  const said = String(
    narrateTaskEvent("task_failed", {
      error:
        "GitHub refused the stored token during the push (401). " +
        "Reconnect GitHub in Settings and ask again.",
    }),
  );
  assert.doesNotMatch(said, /Settings → Agents/u);
  assert.match(said, /Reconnect GitHub in Settings/u);

  // The same guard where a question failed rather than a task.
  assert.doesNotMatch(
    explainAnswerFailure("GitHub answered 401 for the stored token"),
    /Settings → Agents/u,
  );

  // And a genuine vendor sign-in failure still gets its remedy.
  assert.match(
    explainAnswerFailure("OAuth session expired and could not be refreshed"),
    /Reconnect me from Settings → Agents/u,
  );
});

/**
 * A thread hangs off one agent's message about one task, so a reply in it is
 * addressed to that agent and needs no @mention. The route used to store the
 * reply and stop, which is why "what did you get done then?" got silence.
 */
test("a reply in an agent's thread is answered by that agent, with the thread as context", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-reply-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // The thread as the task narrator leaves it: an agent-authored root, and a
  // failure with no detail — exactly the state the question follows.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping a chess engine architecture.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "I could not finish this.",
  });

  runtime.chatAnswer.text = "I got as far as the move generator and stopped.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = listed.data.messages.find(
      (message: any) => message.id === root.id,
    );
    return thread?.replies?.some(
      (reply: any) => reply.content === runtime.chatAnswer.text,
    ) === true;
  }, "the agent never answered the question in its own thread");

  const asked = runtime.chatPrompts.at(-1);
  assert.equal(asked?.userId, ownerId);
  assert.equal(asked?.provider, "anthropic");
  // The thread went with the question: without it the agent is being asked
  // what it did with no record of what it did.
  assert.match(String(asked?.prompt), /what did you get done then\?/u);
  assert.match(String(asked?.prompt), /scoping a chess engine architecture/u);
  assert.match(String(asked?.prompt), /I could not finish this\./u);
  // The answer is attributed to the agent whose thread it is, not the asker.
  const listed = await owner.request(`${base}/messages`);
  const answer = listed.data.messages
    .find((message: any) => message.id === root.id)
    ?.replies?.at(-1);
  assert.equal(answer.kind, "outcome");
  assert.equal(answer.authorId, `${ownerId}:anthropic`);
});

test("a human channel reply extending an agent thread starts exactly one provider turn", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "openai" }]);
  const repositoryId = await invitableRepository(owner, "streamed-thread-reply");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:openai`,
    content: "I updated the retry helper.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "outcome",
    authorId: `${ownerId}:openai`,
    content: "The retry helper now backs off exponentially.",
  });

  runtime.chatAnswer.streamEvents = [
    { type: "status", status: "working" },
    { type: "reasoning_start", hidden: false },
    { type: "reasoning", text: "Checking the earlier result." },
    { type: "text", delta: "It still caps at five attempts." },
  ];
  runtime.chatAnswer.text = "It still caps at five attempts.";
  const before = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "does it still cap the attempts?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (
      thread?.replies.some(
        (reply) =>
          reply.kind === "outcome" &&
          reply.content === "It still caps at five attempts.",
      ) === true
    );
  }, "the resumed provider turn never wrote its terminal reply");

  assert.equal(runtime.chatPrompts.length - before, 1);
  const prompt = runtime.chatPrompts.at(-1);
  assert.equal(prompt?.userId, ownerId);
  assert.equal(prompt?.provider, "openai");
  assert.match(prompt?.prompt ?? "", /backs off exponentially/u);
  assert.equal(
    (prompt?.prompt.match(/does it still cap the attempts\?/gu) ?? []).length,
    1,
    "the new prompt belongs in the provider turn once",
  );

  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  const humanReply = thread?.replies.findIndex(
    (reply) => reply.content === "does it still cap the attempts?",
  ) ?? -1;
  const resumed = thread?.replies.slice(humanReply + 1) ?? [];
  assert.deepEqual(
    resumed.map((reply) => reply.kind),
    ["progress", "progress", "outcome"],
  );
  assert.equal(resumed[0]?.content, "Working…");
  assert.equal(resumed[1]?.content, "Checking the earlier result.");
  assert.equal(resumed[2]?.content, "It still caps at five attempts.");
});

test("each resumed turn emits fresh hidden reasoning and a terminal reply without recursion", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "repeated-thread-turns");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "I finished the config migration.",
  });

  for (const [question, answer] of [
    ["which key changed?", "The key is now retryLimit."],
    ["what is its default?", "Its default is five."],
  ] as const) {
    runtime.chatAnswer.streamEvents = [
      { type: "reasoning_start", hidden: true },
      { type: "reasoning_tokens", tokens: 12 },
      { type: "text", delta: answer },
    ];
    runtime.chatAnswer.text = answer;
    const turnsBefore = runtime.chatPrompts.length;
    const posted = await owner.request(
      `${base}/messages/${encodeURIComponent(root.id)}/replies`,
      { method: "POST", body: { content: question } },
    );
    assert.equal(posted.status, 201);
    await waitFor(async () => {
      const thread = await runtime.store.getChannelMessage(
        repositoryId,
        root.id,
        ownerId,
      );
      return thread?.replies.some(
        (reply) => reply.kind === "outcome" && reply.content === answer,
      ) === true;
    }, `the turn for ${question} never finished`);
    assert.equal(runtime.chatPrompts.length - turnsBefore, 1);
  }

  const thread = await runtime.store.getChannelMessage(
    repositoryId,
    root.id,
    ownerId,
  );
  assert.equal(
    thread?.replies.filter(
      (reply) => reply.kind === "progress" && reply.content === "Thinking…",
    ).length,
    2,
  );
  assert.equal(
    thread?.replies.filter((reply) => reply.kind === "outcome").length,
    2,
  );
  const callsAfterAgentMessages = runtime.chatPrompts.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    runtime.chatPrompts.length,
    callsAfterAgentMessages,
    "agent-authored progress and outcomes must not start provider turns",
  );
  assert.match(
    runtime.chatPrompts.at(-1)?.prompt ?? "",
    /The key is now retryLimit\./u,
  );
});

/**
 * The reader's next move is different for each way an agent can go missing,
 * and one fixed sentence about reconnecting is wrong for three of them. These
 * two cover the pair that actually happen: a sign-in that went away, and an
 * agent taken out of the channel while its threads stayed behind.
 */
test("a reply whose agent is no longer connected says so, and says who can fix it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-gone-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping the move generator.",
  });

  // The credential goes away between the work and the question, which is what
  // an expired or revoked sign-in looks like from here.
  runtime.chatConnections.delete(ownerId);

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.id === root.id);
    return (thread?.replies ?? []).some((reply) => reply.kind === "system");
  }, "a reply to a disconnected agent got no answer at all");

  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  const said = (thread?.replies ?? []).find((reply) => reply.kind === "system");
  assert.match(String(said?.content), /not connected any more/u);
  assert.match(String(said?.content), /Settings → Agents/u);
  // Not in the missing agent's voice: the news is that nobody answered, and
  // attributing it to the absent participant reads as though somebody did.
  assert.equal(said?.authorId, "system");
  assert.equal(
    (thread?.replies ?? []).some(
      (reply) => reply.kind === "agent" && reply.authorId.includes("anthropic"),
    ),
    false,
  );
});

test("a reply whose agent has left the channel says that, not that it is disconnected", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-left-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — scoping the move generator.",
  });
  // Reading the roster first settles the one-time membership backfill, so
  // removing the row below is a removal rather than something the next read
  // grandfathers straight back in.
  assert.equal((await owner.request(`${base}/agents`)).status, 200);
  await runtime.store.setChannelAgentMember(
    repositoryId,
    ownerId,
    "anthropic",
    false,
  );

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);

  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.id === root.id);
    return (thread?.replies ?? []).some((reply) => reply.kind === "system");
  }, "a reply to an agent that left the channel got no answer at all");

  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  const said = (thread?.replies ?? []).find((reply) => reply.kind === "system");
  // The sign-in is fine. Telling somebody to reconnect it sends them to a
  // screen where nothing is wrong.
  assert.match(String(said?.content), /left this channel/u);
  assert.doesNotMatch(String(said?.content), /Settings → Agents/u);
});

test("animation work asked for inside a thread is dispatched with its context", async (t) => {
  // Threads have had shared context for talking since agents began answering
  // follow-ups. Working was the gap, and desired animation phrased as how the
  // UI "should be" behaved like a question instead of entering the task path.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "thread-context-repo");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "The pullout toggle and icon row are ready.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "progress",
    authorId: `${ownerId}:anthropic`,
    content: "Inspecting the pullout styles.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "The icons currently appear and disappear without a transition.",
  });

  runtime.chatAnswer.text = "On it — animating the pullout icons.";
  const request =
    "when toggling this pullout the icons should be animated pulling out " +
    "from the arrow and vice versa when coming back in";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: request } },
  );
  assert.equal(replied.status, 201);

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "asking for work inside a thread never dispatched anything",
  );
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  const context = task.context ?? "";
  assert.match(context, /pullout toggle and icon row/u);
  assert.match(context, /appear and disappear without a transition/u);
  // Progress replies are the run narrating itself. Feeding an agent its own
  // commentary back is noise somebody has already paid for once.
  assert.doesNotMatch(context, /Inspecting the pullout styles/u);
  // The request itself is already the objective; sending it twice only tells
  // the model the same thing twice.
  assert.doesNotMatch(context, /icons should be animated/u);

  // The whole reason this is a field of its own: the objective is rendered in
  // the channel, in task lists and in thread titles, and a transcript folded
  // into it would make every request unreadable in all three.
  assert.match(task.objective, /icons should be animated/u);
  assert.doesNotMatch(task.objective, /currently appear and disappear/u);
});

test("a request that merely opens a thread carries nothing; the follow-up in it does", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "thread-context-e2e");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Rewriter" },
    })).status,
    200,
  );

  runtime.chatAnswer.text = "On it — rewriting the retry helper.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Rewriter please rewrite the retry helper in src/retry.ts" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  // A brand-new request has no history worth carrying — it merely happens to
  // open a thread.
  assert.equal(runtime.submittedTasks[0]?.context, undefined);

  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.ok(threadRoot !== undefined, "the dispatch never opened a thread");

  // What the run narrates back into its own thread while it works, which is
  // the part a follow-up is usually about.
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: threadRoot.id,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "Rewrote src/retry.ts to back off exponentially.",
  });

  const followUp = await owner.request(
    `${base}/messages/${encodeURIComponent(threadRoot.id)}/replies`,
    { method: "POST", body: { content: "now update the config loader the same way" } },
  );
  assert.equal(followUp.status, 201);
  await waitFor(
    async () => runtime.submittedTasks.length > 1,
    "the follow-up inside the thread never dispatched a task",
  );

  const context = runtime.submittedTasks[1]?.context ?? "";
  assert.match(context, /Rewrote src\/retry\.ts/u);
  // The request being dispatched is the objective, not part of its own
  // background.
  assert.doesNotMatch(context, /now update the config loader the same way/u);
  assert.match(
    runtime.submittedTasks[1]?.objective ?? "",
    /update the config loader/u,
  );
});

test("a follow-up to a busy thread agent queues behind its active task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "busy-thread-follow-up");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) handle the current work" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length === 1 && runtime.runCalls.length === 1,
    "the active task never started",
  );
  const current = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.objective.includes("current work"));
  assert.ok(current !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.taskId === current.id);
  assert.ok(root !== undefined, "the active task never opened its thread");

  // This is the shape that used to miss the verb-list task check and enter a
  // provider answer turn. Because that provider is occupied by `current`, it
  // waited for the 180-second question timeout instead of retaining the work.
  const followUp =
    "when I give you another task while this one is in progress, queue it " +
    "for afterward";
  assert.equal(looksLikeTaskRequest(followUp), false);
  const promptsBefore = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: followUp } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));
  await waitFor(
    async () => runtime.submittedTasks.length === 2,
    "the busy agent's follow-up was not retained as queued work",
  );

  assert.equal(
    runtime.chatPrompts.length,
    promptsBefore,
    "a busy provider should not receive a competing direct-answer turn",
  );
  assert.equal(runtime.submittedTasks[1]?.queueAfterCurrent, true);
  assert.equal(
    runtime.runCalls.length,
    1,
    "queued work must not ask the repository to run before its predecessor",
  );
  const queued = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.id !== current.id);
  assert.equal(queued?.afterTaskId, current.id);
  assert.deepEqual(
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID),
    [],
  );

  await runtime.store.completeSubmittedTask(current.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: current.id,
    data: { explanation: "Current work finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 2,
    "the queued follow-up did not start after its predecessor finished",
  );
  const [claimed] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(claimed?.id, queued?.id);
});

/** A thread on a person's message is a conversation between people. */
test("a reply in a person's thread does not summon an agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "human-thread-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "Notes from standup." },
  });
  const before = runtime.chatPrompts.length;
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "what did you get done then?" } },
  );
  assert.equal(replied.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    runtime.chatPrompts.length,
    before,
    "a human thread must not spend somebody's model usage",
  );
});

test("a reply that @mentions an agent in a person's thread reaches that agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic", visibility: "org" }]);
  const repositoryId = await invitableRepository(owner, "human-thread-mention");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Zeus" },
    })).status,
    200,
  );

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "found a bug in the composer" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  runtime.chatAnswer.text = "On it — looking at the composer bug.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "@Zeus can you tackle this" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mentioned agent never picked up the work in the person's thread",
  );
  assert.equal(runtime.submittedTasks[0]?.conversationId, posted.data.message.id);
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /tackle this/u,
  );
  // What this has always been for: the mention dispatched work rather than
  // being answered conversationally. It used to say that as "no provider turn
  // at all", which two later features made untrue without either of them
  // being wrong — the root message above names nobody, so it is classified,
  // and dispatched work now opens with an acknowledgement. Both are spent on
  // purpose; an answer to the reply would not be.
  const answered = runtime.chatPrompts.filter(
    (entry) =>
      !entry.prompt.startsWith("You are an agent in a team chat") &&
      !entry.prompt.startsWith("You have just been asked to do the following"),
  );
  assert.deepEqual(
    answered.map((entry) => entry.prompt.slice(0, 80)),
    [],
    "the mention should dispatch work, never be answered as a question",
  );
});

/**
 * A thread resolved mentions with a raw, case-sensitive substring while the
 * channel two screens away used an anchored case-insensitive match — and the
 * comment above the thread's copy asserted the two were the same. They were
 * not, and the divergence was not a near miss: a reply that named an agent
 * and matched nobody did not fail, it fell through to the agent whose thread
 * it was, which answered under its own name. That is "@mention one agent, a
 * different one replies", produced silently, with nothing anywhere saying the
 * name that was typed went unread.
 */
test("a thread mention matches the way the channel matches, in any case", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-mention-case");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Zeus" },
    })).status,
    200,
  );
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "found a bug in the composer" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // Lowercase. The channel has always accepted this; the thread did not, and
  // what it did instead was answer as somebody else.
  runtime.chatAnswer.text = "On it.";
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "@zeus can you tackle this" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "a lowercase mention in a thread never reached the agent",
  );
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /tackle this/u);
});

/**
 * And in an agent's own thread, a name that belongs to nobody is said out
 * loud rather than quietly handed to that agent.
 *
 * This is the half that produced the report. A thread hangs off one agent's
 * work, so a *bare* question in it is addressed to that agent by
 * construction — that part is right and stays. But a reply that named
 * somebody and matched nobody took the same branch, so the agent whose thread
 * it was answered a message explicitly addressed to a different name, under
 * its own, with nothing saying the name typed had gone unread.
 */
test("a name that belongs to nobody is not answered by the thread's own agent", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  const repositoryId = await invitableRepository(owner, "thread-mention-unknown");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Zeus" },
    })).status,
    200,
  );
  // Zeus's thread: the root names Zeus, so Zeus owns what follows.
  runtime.chatAnswer.text = "On it.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Zeus please look at the composer bug" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the root mention never dispatched",
  );
  const dispatchedByRoot = runtime.submittedTasks.length;

  // A reply naming somebody who does not exist. Zeus must not take it.
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(posted.data.message.id)}/replies`,
    { method: "POST", body: { content: "@Proserpina can you tackle this" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  // The room says nobody answers to that, and names who would have.
  await waitFor(async () => {
    const messages = await owner.request(`${base}/messages`);
    return (messages.data.messages ?? []).some((message: { content?: string }) =>
      /Nobody here answers to that/u.test(String(message.content ?? "")),
    );
  }, "an unresolved mention in an agent's thread said nothing at all");

  // And nothing was dispatched in the mentioned agent's place.
  assert.equal(
    runtime.submittedTasks.length,
    dispatchedByRoot,
    "a name that belongs to nobody must not dispatch work to the thread's agent",
  );
});

test("a channel thread reply carries the message it quotes", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "thread-reply-reference");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "The retry helper still loops forever." },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const rootId = posted.data.message.id;

  const first = await owner.request(`${base}/messages/${rootId}/replies`, {
    method: "POST",
    body: { content: "Can you cap the attempts?" },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const firstReplyId = first.data.reply.id;

  const quoted = await owner.request(`${base}/messages/${rootId}/replies`, {
    method: "POST",
    body: {
      content: "Especially in the config loader.",
      referencedMessageId: firstReplyId,
    },
  });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.data));
  assert.equal(quoted.data.reply.referencedMessageId, firstReplyId);

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as { id: string; replies: { id: string; referencedMessageId?: string }[] }[]).find(
    (message) => message.id === rootId,
  );
  const stored = thread?.replies.find((reply) => reply.id === quoted.data.reply.id);
  assert.equal(stored?.referencedMessageId, firstReplyId);
});

test("a reply in an open thread continues the conversation, whoever it mentions", async (t) => {
  // Stage four of docs/architecture/conversational-tasks.md: the open status
  // is a routing rule. A thread whose task is open is a conversation between
  // turns, and a work request replied into it goes back to the agent whose
  // conversation it is — mentioning somebody else in the reply is content
  // for the turn, not a re-assignment.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "open-thread-repo");
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/agents/anthropic`, {
      method: "POST",
      body: { name: "Keeper" },
    })).status,
    200,
  );
  assert.equal(
    (await owner.request(`${base}/agents/openai`, {
      method: "POST",
      body: { name: "Other" },
    })).status,
    200,
  );

  runtime.chatAnswer.text = "On it — updating the retry helper.";
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Keeper please update the retry helper in src/retry.ts" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );

  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.ok(threadRoot !== undefined, "the dispatch never opened a thread");
  // The first turn already carries the conversation — the thread root's own
  // id — so the task it leaves behind can wait as `open`.
  assert.equal(runtime.submittedTasks[0]?.conversationId, threadRoot.id);
  assert.ok(threadRoot.taskId !== undefined, "the thread never got its task");

  // The turn lands, the way the run loop lands a conversational turn: the
  // claimed task goes open instead of terminal. The store row is what the
  // replies route reads to route the next message.
  await runtime.store.claimSubmittedTasks(repositoryId);
  await runtime.store.openSubmittedTask(threadRoot.taskId);

  // This thread is now older than another room message. Continuing inside it
  // should update the conversation without changing either root's position.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newerRoot = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: ownerId,
    content: "A newer room message that should remain below the thread.",
  });
  const beforeReply = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.ok(
    beforeReply.findIndex((message) => message.id === threadRoot.id) <
      beforeReply.findIndex((message) => message.id === newerRoot.id),
    "the test needs an older thread followed by a newer room message",
  );

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(threadRoot.id)}/replies`,
    {
      method: "POST",
      body: { content: "@Other now update the config loader the same way" },
    },
  );
  assert.equal(replied.status, 201);
  await waitFor(
    async () => runtime.submittedTasks.length > 1,
    "the reply never continued the conversation",
  );

  // Same conversation, same agent — the mention of @Other rode along as
  // content rather than redirecting the work.
  assert.equal(runtime.submittedTasks[1]?.conversationId, threadRoot.id);
  assert.equal(
    runtime.submittedTasks[1]?.vendor,
    runtime.submittedTasks[0]?.vendor,
  );
  assert.match(
    runtime.submittedTasks[1]?.objective ?? "",
    /config loader/u,
  );
  const afterReply = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.deepEqual(
    afterReply.map((message) => message.id),
    beforeReply.map((message) => message.id),
    "replying inside a thread must preserve its channel position",
  );
  const updatedRoot = afterReply.find(
    (message) => message.id === threadRoot.id,
  );
  assert.ok(
    updatedRoot?.replies.some(
      (reply) =>
        reply.kind === "user" &&
        reply.content === "@Other now update the config loader the same way",
    ),
    "the reply must still append to the intended thread",
  );
  // And the next turn's submission settled the previous open one: at most
  // one turn of a conversation is ever open.
  const settled = (
    await runtime.store.listSubmittedTasks({ repositoryId })
  ).find((task) => task.id === threadRoot.taskId);
  assert.equal(settled?.status, "integrated");
});

/*
 * Per-repository role labels: a `role` override on `setChannelAgentOverride`
 * (see `ChannelAgentOverride` in store.ts) is the only source of an agent's
 * role — there is no vendor-guessed default — and reaches the roster and,
 * for a dispatched task, the objective the agent actually receives.
 */

test("a channel's role override reaches the roster and the objective a dispatched task receives", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "role-override-repo");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Before any override, the agent is unlabeled — no vendor-guessed default.
  // (The roster route itself carries no `role` field; the client resolves it
  // from `agentOverrides`, same as `name`/`model`/`effort` — see
  // `channelAgentsFor` in data.js. What this route needs to keep working is
  // just that it still answers normally with nothing set.)
  const beforeRoster = await owner.request(`${base}/agents`);
  assert.equal(beforeRoster.status, 200, JSON.stringify(beforeRoster.data));

  const overridden = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "Frontend Agent" },
  });
  assert.equal(overridden.status, 200, JSON.stringify(overridden.data));
  assert.equal(overridden.data.override.role, "Frontend Agent");

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please tidy up the settings layout" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const [task] = runtime.submittedTasks;
  assert.ok(task !== undefined);
  // The role the channel declared reaches the actual prompt content, ahead
  // of the request itself — see `withRoleContext` and its call site in
  // `dispatchOneMention`.
  assert.match(task.objective, /^Your role in this repository: Frontend Agent\.\n\n/u);
  assert.match(task.objective, /tidy up the settings layout/u);

  // Clearing the role (an empty string, same as clearing model/effort) goes
  // back to unlabeled — there is no vendor-wide default to fall back to —
  // so the objective is left untouched rather than prefixing anything.
  const cleared = await owner.request(`${base}/agents/anthropic`, {
    method: "POST",
    body: { role: "" },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  const postedAgain = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) one more thing please" },
  });
  assert.equal(postedAgain.status, 201);
  const [, second] = runtime.submittedTasks;
  assert.ok(second !== undefined);
  // The request opens the objective with nothing prefixed to it; the
  // directives every task carries follow it.
  assert.match(second.objective, /^one more thing please\n\n/u);
  assert.doesNotMatch(second.objective, /^Your role in this repository/u);
});

test("a thread carries what its task changed, and keeps it", async (t) => {
  // What the thread could not previously answer. The narration said "wrote
  // changes to a.ts, b.ts and 2 more" once, in passing, and scrolled away;
  // there was nothing a reader could come back to.
  const runtime = await startRuntime(t, { auditorPollIntervalMs: 20 });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "thread-changes");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1);
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.id;
  assert.ok(taskId !== undefined);

  // The thread is joined to the work, so the summary stays attributable once
  // the process that watched the run is gone.
  const threadRoot = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.equal(threadRoot?.taskId, taskId);

  // What the run reports while it works.
  await runtime.store.appendAudit(undefined, {
    type: "workspace_changed",
    taskId,
    data: {
      files: [
        { path: "src/retry.ts", status: "modified" },
        { path: "src/retry.test.ts", status: "added" },
      ],
      changed: ["src/retry.ts"],
    },
  });

  await waitFor(async () => {
    const message = (await runtime.store.listChannelMessages(repositoryId, ownerId)).find(
      (entry) => entry.kind === "user" && entry.taskId !== undefined,
    );
    return (message?.changedFiles?.length ?? 0) > 0;
  }, "the thread never picked up what the run was changing");

  const listed = await owner.request(`${base}/messages`);
  const thread = (listed.data.messages as any[]).find(
    (message) => message.kind === "user" && message.taskId !== undefined,
  );
  assert.deepEqual(thread.changedFiles, [
    { path: "src/retry.ts", status: "modified" },
    { path: "src/retry.test.ts", status: "added" },
  ]);

  // The final set replaces the live one rather than merging into it: an agent
  // that reverts itself leaves a file no longer changed, and a summary built
  // by accumulating deltas would keep claiming an edit that is gone.
  await runtime.store.appendAudit(undefined, {
    type: "changeset_collected",
    taskId,
    data: {
      changeSetId: "changeset_1",
      files: ["src/retry.ts"],
      changedFiles: [{ path: "src/retry.ts", status: "modified" }],
    },
  });
  await waitFor(async () => {
    const message = (await runtime.store.listChannelMessages(repositoryId, ownerId)).find(
      (entry) => entry.kind === "user" && entry.taskId !== undefined,
    );
    return message?.changedFiles?.length === 1;
  }, "the final changeset never replaced the live summary");
});

test("a task nobody picks up is said so in its thread, once", async (t) => {
  // `waitingForAMachine` is decided once, at dispatch. A machine that was live
  // at that instant and then went away leaves the thread saying "I've taken
  // this task and I'm working on it" in front of a row nothing will ever
  // claim. The offline exchange cannot reach this: it runs strictly before
  // dispatch and answers the case where the agent already reads as offline.
  const runtime = await startRuntime(t, {
    threadReconcileIntervalMs: 40,
    stalledTaskMs: 0,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "nobody-home");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rename the button" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "submitted");

  const noticesFor = async (): Promise<string[]> => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    const root = messages.find((message) => message.taskId === task?.id);
    return (root?.replies ?? [])
      .filter((reply) => reply.kind === "system")
      .map((reply) => reply.content);
  };

  // Two full sweeps. The second is the point: the notice is recorded against
  // the task rather than in memory, so it is said once however often the
  // reconciler runs — and a restart does not say it again either.
  await waitFor(
    async () => (await noticesFor()).length > 0,
    "the sweep never said anything about a task nobody claimed",
  );
  await new Promise((resolve) => setTimeout(resolve, 140));
  const notices = await noticesFor();
  assert.equal(notices.length, 1, notices.join(" | "));
  assert.match(notices[0] ?? "", /Nothing has picked this up/u);
  // Not a cancellation. The work is still good and still runs if the machine
  // comes back; what was missing was anybody saying it had not started.
  const [after] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(after?.status, "submitted");
  assert.equal(
    (await runtime.store.listAuditEvents({ taskId: task?.id, types: ["task_stalled"] }))
      .length,
    1,
  );
});

test("a task that is merely waiting its turn is left alone", async (t) => {
  // Two ways a queued row is fine, and the sweep must recognise both or it
  // narrates ordinary work as a fault every minute.
  const runtime = await startRuntime(t, {
    threadReconcileIntervalMs: 40,
    stalledTaskMs: 0,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "busy-room");

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) the first thing" },
  });
  const [queued] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.ok(queued !== undefined);

  // A live lease anywhere in this repository means work is moving and this
  // row is behind it.
  const worker = await runtime.store.registerWorker({
    userId: ownerId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "a-machine",
    adapters: ["claude"],
    version: "1",
  });
  const busy = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "work that is actually running",
    agentId: "claude",
    validationCommands: [],
  });
  const leased = await runtime.store.leaseNextTask({
    workerId: worker.id,
    taskId: busy.id,
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    baseRevision: "b".repeat(40),
    ttlMs: 60_000,
  });
  assert.ok(leased !== undefined, "the second task should have been leased");

  await new Promise((resolve) => setTimeout(resolve, 160));
  const messages = await runtime.store.listChannelMessages(repositoryId, ownerId);
  const root = messages.find((message) => message.taskId === queued.id);
  assert.deepEqual(
    (root?.replies ?? [])
      .filter((reply) => reply.kind === "system")
      .map((reply) => reply.content),
    [],
    "a room with work in flight should say nothing about the queue behind it",
  );
});

test("a command and a mention work together, and /plan holds the run", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "slash-commands");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The command says how to treat the request; the "@" says who for. The
  // objective must survive both being taken off.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /rework the retry loop/u);
  assert.doesNotMatch(runtime.submittedTasks[0]?.objective ?? "", /\/plan/u);

  // Filed as held, and deliberately not started. `planned` rather than
  // `submitted` is the whole point: `submitted` means "queued to run", which
  // is what every lease query selects on, so a hold spelled that way was
  // indistinguishable from ordinary queued work.
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.equal(
    root?.replies[0]?.content,
    "I've taken this task and I'm working on the plan.",
  );
  const replies = (root?.replies ?? []).map((reply) => reply.content).join("\n");
  assert.doesNotMatch(replies, /That's the plan/u);
  assert.match(replies, /Waiting on you/u);
  assert.match(replies, /reply "go ahead" and I'll start/iu);
  // The plan itself is a reply of its own kind, not another agent remark:
  // that mark is what lets the browser keep the document out of the thread
  // and open it in its own panel beside the room.
  const plan = (root?.replies ?? []).filter((reply) => reply.kind === "plan");
  assert.equal(plan.length, 1, JSON.stringify(root?.replies));
  assert.ok((plan[0]?.content ?? "").trim().length > 0);
  // And the thread still names itself, so every surface that reads a title
  // off the "Task:" line keeps working.
  assert.equal(
    (root?.replies ?? []).filter((reply) => /^Task: /u.test(reply.content)).length,
    1,
    JSON.stringify(root?.replies),
  );
  // The plan was thought about with the code open. `/plan` used to be
  // answered by the same cheap ceremonial call that writes a thread's opening
  // caption — no repository, low effort — so it could only restate the
  // request back. This is the check that it asks with the checkout in hand.
  const planning = runtime.chatPrompts.find((entry) =>
    /read-only checkout of this repository/u.test(entry.prompt),
  );
  assert.notEqual(planning, undefined, JSON.stringify(runtime.chatPrompts));
  assert.equal(planning?.repositoryId, repositoryId);

  // The browser retires the typing dots by looking this task up in the list
  // it polls and finding a status outside its working set. That only works if
  // the list carries the task at all — a held plan filtered out of the API
  // would leave `agentsThinkingIn` unable to find it, and the agent would
  // show as thinking for the full ten-minute backstop underneath a message
  // that says in words that nothing is running.
  const listed = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks`,
  );
  assert.equal(listed.status, 200);
  assert.equal(
    (listed.data.tasks as Array<{ id: string; status: string }>).find(
      (entry) => entry.id === task?.id,
    )?.status,
    "planned",
    JSON.stringify(listed.data.tasks),
  );
  // And the filter knows the status, so asking for held work is not a 400.
  const filtered = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/tasks?status=planned`,
  );
  assert.equal(filtered.status, 200);
  assert.equal((filtered.data.tasks as unknown[]).length, 1);

  // And "go ahead" is what starts it.
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const thread = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (thread?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "the approved plan never started");
});

test("only the person who asked can start a held plan", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-owner");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const bystander = await addColleague(runtime, "bystander@example.com");

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  const thread = `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`;

  // Somebody else in the room says go. The plan is not theirs to spend: it
  // runs on the account of whoever asked for it, and nothing about the
  // thread tells them that, so the refusal has to.
  const notTheirs = await bystander.client.request(thread, {
    method: "POST",
    body: { content: "go ahead" },
  });
  assert.equal(notTheirs.status, 201);
  await waitFor(async () => {
    const held = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (held?.replies ?? []).some((reply) => /Owner's to start/u.test(reply.content));
  }, "the bystander was never told whose plan this is");

  // And it really is still held — the refusal is the point, not the wording.
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "planned",
  );

  // The person who asked says the same words, and it starts.
  const theirs = await owner.request(thread, {
    method: "POST",
    body: { content: "go ahead" },
  });
  assert.equal(theirs.status, 201);
  await waitFor(async () => {
    const started = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (started?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "the plan's own author could not start it");
});

test("a held plan nobody is recorded as asking for still starts", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-orphan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Work filed outside a channel — over the API, or from the command line —
  // records nobody as having asked. Held plans like that predate this rule
  // and would otherwise be unstartable by anyone, which is worse than the
  // thing the rule prevents.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "hud-agent",
    validationCommands: [],
    planOnly: true,
  });
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "That's the plan — nothing is running yet.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);

  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const released = (
      await runtime.store.listSubmittedTasks({ repositoryId })
    ).find((entry) => entry.id === task.id);
    return released?.status !== "planned";
  }, "a plan with no recorded requester was stranded");
});

test("a plan nobody starts is let go, and a late go-ahead is told why", async (t) => {
  const runtime = await startRuntime(t, {
    // The deadline itself, compressed. This is about what happens when a hold
    // runs out, not about how long fifteen minutes is — but long enough that
    // the hold below is fully written before its clock can run out, which is
    // the one thing a zero would make racy.
    planHoldTtlMs: 250,
    threadReconcileIntervalMs: 25,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-lapse");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Filed straight into the store, which is also the shape a hold has after
  // the deploy that killed the process holding it: a `planned` row, a thread,
  // and nothing in this gateway's memory that knows either exists. If the
  // deadline lived in a timer this is exactly the case it would miss.
  const task = await runtime.store.submitTask({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    objective: "rework the retry loop",
    agentId: "hud-agent",
    validationCommands: [],
    planOnly: true,
  });
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "That's the plan — nothing is running yet.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, task.id);

  const lapseNotices = async (): Promise<string[]> =>
    (
      (await runtime.store.getChannelMessage(repositoryId, root.id, ownerId))
        ?.replies ?? []
    )
      .map((reply) => reply.content)
      .filter((content) => /Plan expired/u.test(content));

  await waitFor(
    async () => (await lapseNotices()).length > 0,
    "a plan nobody started was still held after its deadline",
  );
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "cancelled",
    "the thread said the plan had lapsed while the task was still held",
  );

  const said = await lapseNotices();
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0] ?? "", /nobody started this/iu);
  // Not the hold's own opening: the browser recognises that one and would go
  // on drawing this as a thread still waiting on somebody.
  assert.doesNotMatch(said[0] ?? "", /Waiting on you/u);

  // The sweep runs on a timer, so it sees this thread again and again. One
  // lapse, one line.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await lapseNotices()).length, 1);

  // And the answer that arrives too late is answered, rather than dropped
  // into the chat model as a stray "go ahead".
  const late = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(late.status, 201);
  await waitFor(async () => {
    const answered = await runtime.store.getChannelMessage(
      repositoryId,
      root.id,
      ownerId,
    );
    return (answered?.replies ?? []).some((reply) =>
      /ran out of time/u.test(reply.content),
    );
  }, "a go-ahead after the deadline was met with silence");
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (entry) => entry.id === task.id,
    )?.status,
    "cancelled",
    "a lapsed plan was started by a late go-ahead",
  );
});

test("a plan still inside its deadline is left alone", async (t) => {
  const runtime = await startRuntime(t, {
    // A minute, so the sweep below is running against a deadline that has
    // certainly not passed — and the test never depends on what the
    // environment has configured.
    planHoldTtlMs: 60_000,
    threadReconcileIntervalMs: 25,
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "plan-hold-live");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(task?.status, "planned");

  // Several sweeps, all of them a long way inside the deadline.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId }))[0]?.status,
    "planned",
    "a plan well inside its deadline was let go",
  );
  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  assert.ok(
    !(root?.replies ?? []).some((reply) => /Plan expired/u.test(reply.content)),
    JSON.stringify(root?.replies),
  );

  // And it still starts, which is the behaviour the deadline must not cost.
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201);
  await waitFor(async () => {
    const started = (
      await runtime.store.listChannelMessages(repositoryId, ownerId)
    ).find((message) => message.kind === "user" && message.taskId !== undefined);
    return (started?.replies ?? []).some((reply) =>
      /Starting now/u.test(reply.content),
    );
  }, "a live plan could no longer be started");
});

test("/queue chains one agent's follow-up work without claiming it early", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "slash-queue");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
    { provider: "openai", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Bad queue commands are explained and never create empty or unroutable
  // work.
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue do this later" },
  });
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue @Claude (Owner)" },
  });
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "/queue @Claude (Owner) @Codex (Owner) duplicate work",
    },
  });
  assert.equal(runtime.submittedTasks.length, 0);
  const rejected = await owner.request(`${base}/messages`);
  assert.match(
    (rejected.data.messages as Array<{ content: string }>)
      .map((message) => message.content)
      .join("\n"),
    /\/queue @agent what should run next/u,
  );

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) handle current work" },
  });
  const current = (await runtime.store.listSubmittedTasks({ repositoryId }))[0];
  assert.ok(current !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);

  for (const objective of ["first follow-up", "second follow-up"]) {
    const posted = await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: `/queue @Claude (Owner) ${objective}` },
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
  }
  assert.equal(runtime.submittedTasks.length, 3);
  assert.ok(
    runtime.submittedTasks
      .slice(1)
      .every((task) => task.queueAfterCurrent === true),
  );
  assert.equal(runtime.runCalls.length, 1);
  const tasks = await runtime.store.listSubmittedTasks({ repositoryId });
  const first = tasks.find((task) => task.objective.includes("first follow-up"));
  const second = tasks.find((task) => task.objective.includes("second follow-up"));
  assert.equal(first?.afterTaskId, current.id);
  assert.equal(second?.afterTaskId, first?.id);
  const queuedRoots = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    queuedRoots
      .flatMap((root) => root.replies)
      .filter(
        (reply) =>
          reply.content ===
          "I've taken this task and queued it behind my current work.",
      ).length,
    2,
  );
  assert.deepEqual(
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID),
    [],
  );

  await runtime.store.completeSubmittedTask(current.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: current.id,
    data: { explanation: "Current work finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 2,
    "the first queued task was not started after its predecessor finished",
  );
  const [firstClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(firstClaim?.id, first?.id);
  assert.ok(first !== undefined);
  await runtime.store.completeSubmittedTask(first.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: first.id,
    data: { explanation: "First follow-up finished." },
  });
  await waitFor(
    async () => runtime.runCalls.length === 3,
    "the second queued task was not started after the first finished",
  );
  const [secondClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(secondClaim?.id, second?.id);
  assert.ok(second !== undefined);
  await runtime.store.completeSubmittedTask(second.id, "integrated");

  // With no unfinished task, the same command is submitted normally and is
  // immediately claimable.
  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue @Claude (Owner) idle follow-up" },
  });
  const idle = (await runtime.store.listSubmittedTasks({ repositoryId })).find(
    (task) => task.objective.includes("idle follow-up"),
  );
  assert.equal(idle?.afterTaskId, undefined);
  assert.equal(runtime.runCalls.length, 4);
  const [idleClaim] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(idleClaim?.id, idle?.id);
});

test("/dnc is answered without announcing the constraint and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-answers-only");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "The retry loop backs off twice and then gives up.";

  // Worded as work on purpose: without the command this sentence is a task.
  // "Do not code" has to beat the verb reading, not just accompany it.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // An answer, not a task: nothing submitted, nothing to open a thread for.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.equal(answer?.content, runtime.chatAnswer.text);

  // The prompt makes the constraint silent, and the command word was lifted
  // out, so the message the agent is asked to answer is the sentence, not the
  // syntax. (The prompt's channel-context section may still quote the raw
  // "/dnc" line; "The message:" is the part that must be clean.)
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /without mentioning `\/dnc`/u);
  assert.match(prompt, /calling it a do-not-code request/u);
  assert.match(prompt, /The message: @Claude \(Owner\) rework the retry loop/u);
});

test("/dnc and @agents answers never auto-dispatch suggested work", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "answer-task-guards");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.channelAnswerText =
    "The retry loop should use a bounded backoff.\n" +
    "ANSWER_TASK: Bound the retry loop and add regression coverage";

  const readOnly = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) should the retry loop be bounded?" },
  });
  assert.equal(readOnly.status, 201, JSON.stringify(readOnly.data));

  const broadcast = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@agents should the retry loop be bounded?" },
  });
  assert.equal(broadcast.status, 201, JSON.stringify(broadcast.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answers = (listed.data.messages as any[]).filter(
    (message) => message.kind === "agent",
  );
  assert.equal(answers.length, 2, JSON.stringify(listed.data.messages));
  assert.ok(
    answers.every(
      (message) =>
        message.content === "The retry loop should use a bounded backoff.",
    ),
    JSON.stringify(answers),
  );
  assert.ok(
    answers.every((message) => !String(message.content).includes("ANSWER_TASK")),
    JSON.stringify(answers),
  );
});

test("/dnc prompt permits read-only shell inspection but forbids edits", async (t) => {
  // "Do not code" is not "do not look". Asked for a line count, the agent used
  // to answer that it had no permission to run a shell command — a refusal the
  // reader could do nothing about, in place of the number they asked for.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-may-look");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "About 90,000 lines across 400 files.";

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @Claude (Owner) just give me a LOC report" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));

  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  // Commands are asked for by name, in either shell the host might run.
  assert.match(prompt, /run whatever shell commands you need/u);
  assert.match(prompt, /bash or PowerShell/u);
  // And the half that has to survive: reading only, and no code.
  assert.match(prompt, /as long as they only read/u);
  assert.match(prompt, /Do not write or change code/u);
  assert.doesNotMatch(prompt, /Do not write, change, or run anything/u);
});

test("/dnc in a thread is answered without announcing the constraint or filing a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "dnc-thread-answers-only");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  // An agent-authored thread: the place where a work-verbed reply used to be
  // dispatched as a task even when the command promised it would not be.
  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — reworking the retry helper.",
  });

  runtime.chatAnswer.text = "It retries twice and then backs off for good.";
  // Worded as work on purpose, like the channel test above: the command has
  // to beat the verb reading in a thread too.
  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "/dnc rework the retry loop" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  await waitFor(async () => {
    const listed = await owner.request(`${base}/messages`);
    const thread = (listed.data.messages as any[]).find(
      (message) => message.id === root.id,
    );
    return thread?.replies?.some(
      (reply: any) => reply.content === runtime.chatAnswer.text,
    ) === true;
  }, "the do-not-code reply was never answered in its thread");

  // Answered, never dispatched — no task is the whole guarantee: nothing to
  // plan, nothing for the coordinator to run.
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /calling it a do-not-code request/u);
  // The command word is lifted out of the question slot, as in the channel.
  assert.match(prompt, /The question: rework the retry loop/u);
});

test("/ask always submits a task marked for a forced question round", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-forces-questions");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // The command written last must be lifted out and remembered structurally,
  // not lost because it was not the first word in the message.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) change the background color /ask" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /change the background color/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
  assert.doesNotMatch(runtime.submittedTasks[0]?.objective ?? "", /\/ask/u);
});

test("/ask bypasses the direct-answer path even when its objective is a question", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ask-question-task");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: {
      content: "/ask @Claude (Owner) which background color should we use?",
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /which background color should we use\?/u,
  );
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
});

test("/ask in a thread reply starts the same forced question task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [{ provider: "anthropic" }]);
  const repositoryId = await invitableRepository(owner, "ask-thread-questions");
  await joinAllConnectedAgents(runtime, repositoryId);
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it — reworking the dashboard styles.",
  });

  const replied = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "change the background color /ask" } },
  );
  assert.equal(replied.status, 201, JSON.stringify(replied.data));

  await waitFor(async () => {
    return runtime.submittedTasks.length === 1;
  }, "the thread /ask was never dispatched");

  assert.equal(runtime.submittedTasks[0]?.conversationId, root.id);
  assert.match(
    runtime.submittedTasks[0]?.objective ?? "",
    /force a question round before implementation/u,
  );
});

test("only a reply that adds nothing counts as the request repeated back", () => {
  // The reported case, quotes and capitals and all.
  assert.equal(
    readsAsEchoOfRequest("@Zeus change the background color", '"Change the background"'),
    true,
  );
  assert.equal(
    readsAsEchoOfRequest("change the background color", "change the background color"),
    true,
  );
  // Anything that says something is an answer, however short.
  assert.equal(
    readsAsEchoOfRequest(
      "change the background color",
      "Changing the background means editing the dashboard stylesheet.",
    ),
    false,
  );
  assert.equal(readsAsEchoOfRequest("is the retry loop bounded?", "Yes."), false);
  assert.equal(readsAsEchoOfRequest("", "Change the background"), false);
});

test("/dnc with nobody mentioned never auto-claims, and says how to ask", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-no-mention");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  // Task-worded and unaddressed — without the command this is exactly the
  // message auto-claim dispatches. The command's promise has to hold on this
  // path too.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc fix the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const after = await owner.request(`${base}/messages`);
  const contents = (after.data.messages as any[]).map((message) =>
    String(message.content),
  );
  assert.ok(
    contents.every((line) => !/^Want me to take this/u.test(line)),
    JSON.stringify(contents),
  );
  // Not silence either: the sender is told what a do-not-code ask needs.
  const hint = (after.data.messages as any[]).find(
    (message) => message.kind === "system",
  );
  assert.match(String(hint?.content), /`\/dnc` answers without starting work/u);
  assert.match(String(hint?.content), /\/dnc @agent your question/u);
});

test("@agents /dnc silently keeps every answer read-only and files no task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "dnc-broadcast");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);
  runtime.chatAnswer.text = "The retry loop caps at five attempts.";

  // Task-worded and not a question: without the command the broadcast gate
  // refuses this outright as a would-be broadcast task. The command says it
  // is a question, so the verb reading must give way here as everywhere.
  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/dnc @agents rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  const listed = await owner.request(`${base}/messages`);
  const answer = (listed.data.messages as any[]).find(
    (message) => message.kind === "agent",
  );
  assert.equal(answer?.content, runtime.chatAnswer.text);
  // The silent read-only constraint reaches every answer of the fan-out, in
  // the same directive slot the single-mention path fills.
  const prompt = runtime.chatPrompts.at(-1)?.prompt ?? "";
  assert.match(prompt, /Silently treat this as read-only/u);
  assert.match(prompt, /without mentioning `\/dnc`/u);
});

test("/simple keeps it brief in both places a reply is written from", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "personal" },
  ]);

  // Work: the directive rides inside the objective string itself, so it
  // reaches the worker with no new field anywhere between here and there.
  const taskRepo = await invitableRepository(owner, "simple-brief-task");
  await joinAllConnectedAgents(runtime, taskRepo);
  const taskBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${taskRepo}/channel`;
  const work = await owner.request(`${taskBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) rework the retry loop" },
  });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const objective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(objective, /rework the retry loop/u);
  assert.match(objective, /short and simple/u);
  assert.doesNotMatch(objective, /\/simple/u);

  // A question: the same ask lands in the answer prompt instead, and still
  // never becomes a task.
  const askRepo = await invitableRepository(owner, "simple-brief-question");
  await joinAllConnectedAgents(runtime, askRepo);
  const askBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${askRepo}/channel`;
  const asked = await owner.request(`${askBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) what are you working on?" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  // Found by content rather than taken from the end: the task above owes an
  // un-awaited opening-thoughts call that could land in `chatPrompts` at any
  // time.
  const prompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("what are you working on?"));
  assert.ok(prompt, JSON.stringify(runtime.chatPrompts));
  assert.match(prompt ?? "", /short and simple/u);

  // A terse answer request has no question mark or interrogative opener, but
  // it is still asking for information. Keep it on the same read-only answer
  // path instead of manufacturing an empty edit task whose result starts with
  // "No files changed".
  const summaryRepo = await invitableRepository(owner, "simple-brief-summary");
  await joinAllConnectedAgents(runtime, summaryRepo);
  const summaryBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${summaryRepo}/channel`;
  const summarized = await owner.request(`${summaryBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) summary of the codebase" },
  });
  assert.equal(summarized.status, 201, JSON.stringify(summarized.data));
  assert.equal(runtime.submittedTasks.length, 1, JSON.stringify(runtime.submittedTasks));
  const summaryPrompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("summary of the codebase"));
  assert.ok(summaryPrompt, JSON.stringify(runtime.chatPrompts));
  assert.match(summaryPrompt ?? "", /short and simple/u);
});

test("every task and every answer is told to end on the answer, not a status", async (t) => {
  // What was reaching the room: "I'll wait for the search agent to finish and
  // report back", posted verbatim as the reply, read as the answer by
  // everybody in the channel. No command asks for this and none can turn it
  // off — it rides with plain work and plain questions alike.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "personal" },
  ]);

  const taskRepo = await invitableRepository(owner, "answer-not-status-task");
  await joinAllConnectedAgents(runtime, taskRepo);
  const taskBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${taskRepo}/channel`;
  const work = await owner.request(`${taskBase}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rework the retry loop" },
  });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const objective = runtime.submittedTasks[0]?.objective ?? "";
  assert.match(objective, /final message is the answer, not a status report/u);
  assert.match(objective, /never end a turn saying a search is running/u);

  const askRepo = await invitableRepository(owner, "answer-not-status-question");
  await joinAllConnectedAgents(runtime, askRepo);
  const askBase = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${askRepo}/channel`;
  const asked = await owner.request(`${askBase}/messages`, {
    method: "POST",
    body: { content: "/simple @Claude (Owner) what are you working on?" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  const prompt = runtime.chatPrompts
    .map((entry) => entry.prompt)
    .find((entry) => entry.includes("what are you working on?"));
  assert.ok(prompt, JSON.stringify(runtime.chatPrompts));
  assert.match(prompt ?? "", /final message is the answer, not a status report/u);
  // `/simple` still applies, and reads after it: brevity is the outer
  // instruction, and the shortest true answer satisfies both.
  assert.match(prompt ?? "", /short and simple/u);
  assert.ok(
    (prompt ?? "").indexOf("final message is the answer") <
      (prompt ?? "").indexOf("short and simple"),
    prompt ?? "",
  );
});

test("/push publishes directly as the sender without planning or running a task", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-command");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/push" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
  ]);
  assert.equal(runtime.submittedTasks.length, 0, JSON.stringify(runtime.submittedTasks));
  assert.equal(runtime.runCalls.length, 0);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /Pushed canonical to coord\/export-test on GitHub/u,
  );
});

test("/push returns a sync choice and its retry publishes after that choice", async (t) => {
  const runtime = await startRuntime(t, {
    pushOutcomes: [
      {
        outcome: "refused",
        detail: {
          syncConflict: true,
          conflicts: ["src/shared.ts"],
        },
        explanation: "Both sides changed src/shared.ts.",
      },
      {
        outcome: "done",
        explanation: "Pushed to coord/resolved-sync on GitHub.",
      },
    ],
  });
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-sync-choice");
  const messages =
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel/messages`;

  const posted = await owner.request(messages, {
    method: "POST",
    body: { content: "/push" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.command, {
    name: "push",
    result: {
      outcome: "refused",
      detail: {
        syncConflict: true,
        conflicts: ["src/shared.ts"],
      },
      explanation: "Both sides changed src/shared.ts.",
    },
  });
  const beforeRetry = await owner.request(messages);
  assert.doesNotMatch(
    (beforeRetry.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Both sides changed/u,
  );

  const retried = await owner.request(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/push`,
    { method: "POST", body: {} },
  );
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.push.outcome, "done");
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
  ]);
  const afterRetry = await owner.request(messages);
  assert.match(
    (afterRetry.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /Pushed to coord\/resolved-sync on GitHub/u,
  );
});

test("/push reports refusals and unsupported deployments in the channel", async (t) => {
  const runtime = await startRuntime(t, {
    pushOutcome: {
      outcome: "refused",
      explanation: "You haven't connected GitHub, so nothing was pushed.",
    },
  });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-refused");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;
  assert.equal(
    (await owner.request(`${base}/messages`, {
      method: "POST",
      body: { content: "/push" },
    })).status,
    201,
  );
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((message) => String(message.content)).join("\n"),
    /haven't connected GitHub/u,
  );
  assert.equal(runtime.submittedTasks.length, 0);

  const limitedRuntime = await startRuntime(t, { withoutPushRepository: true });
  const limitedOwner = new TestClient(limitedRuntime.origin);
  await bootstrap(limitedOwner);
  const limitedRepository = await invitableRepository(
    limitedOwner,
    "push-unsupported",
  );
  const limitedBase =
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${limitedRepository}/channel`;
  assert.equal(
    (await limitedOwner.request(`${limitedBase}/messages`, {
      method: "POST",
      body: { content: "/push" },
    })).status,
    201,
  );
  const limitedListed = await limitedOwner.request(`${limitedBase}/messages`);
  assert.match(
    (limitedListed.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /cannot push repositories from the channel/u,
  );
  assert.equal(limitedRuntime.submittedTasks.length, 0);
});

test("/queue /push publishes immediately when nothing is running", async (t) => {
  // "After the running work" with no running work is not a special case — it
  // is the same instruction whose moment has already arrived. Nothing is
  // filed, nothing is held, and the outcome is said in the room.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "queued-push-idle");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue /push" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: bootstrapped.user.id,
    },
  ]);
  assert.equal(
    runtime.submittedTasks.length,
    0,
    JSON.stringify(runtime.submittedTasks),
  );
  // Nothing was queued, so nothing had to be released either.
  assert.equal(runtime.runCalls.length, 0);
  const listed = await owner.request(`${base}/messages`);
  const said = (listed.data.messages as any[])
    .map((message) => String(message.content))
    .join("\n");
  assert.match(said, /Pushed canonical to coord\/export-test on GitHub/u);
  assert.doesNotMatch(said, /I'll publish once/u);
});

test("/queue /push queues what follows and publishes once running work finishes", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "queued-push-waits");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) handle current work" },
  });
  const current = (await runtime.store.listSubmittedTasks({ repositoryId }))[0];
  assert.ok(current !== undefined);
  await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID);
  assert.equal(runtime.runCalls.length, 1);

  const asked = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/queue /push" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  // Nothing is published while that task is still claimed, and the promise to
  // publish later is said out loud — the silence after it is deliberate, and
  // only this line makes that legible.
  assert.deepEqual(runtime.pushCalls, []);
  const waiting = await owner.request(`${base}/messages`);
  assert.match(
    (waiting.data.messages as any[])
      .map((message) => String(message.content))
      .join("\n"),
    /I'll publish once the work running here has finished/u,
  );

  // Work asked for after that message is filed and held rather than started:
  // running it would move canonical out from under the very push it is
  // waiting for.
  const queued = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rework the retry loop" },
  });
  assert.equal(queued.status, 201, JSON.stringify(queued.data));
  assert.equal(runtime.submittedTasks.length, 2);
  assert.equal(runtime.submittedTasks[1]?.queueAfterCurrent, true);
  assert.equal(runtime.runCalls.length, 1);
  const follower = (await runtime.store.listSubmittedTasks({ repositoryId })).find(
    (task) => task.objective.includes("rework the retry loop"),
  );
  assert.equal(follower?.status, "submitted");
  assert.deepEqual(
    await runtime.store.claimSubmittedTasks(repositoryId, DEFAULT_PROJECT_ID),
    [],
  );

  await runtime.store.completeSubmittedTask(current.id, "integrated");
  await runtime.store.appendAudit(undefined, {
    type: "task_reported",
    taskId: current.id,
    data: { explanation: "Current work finished." },
  });
  await waitFor(
    async () => runtime.pushCalls.length === 1,
    "the queued push did not publish once the running work finished",
  );
  assert.deepEqual(runtime.pushCalls, [
    {
      projectId: DEFAULT_PROJECT_ID,
      repositoryId,
      actorId: ownerId,
    },
  ]);
  const published = await owner.request(`${base}/messages`);
  const outcome = (published.data.messages as any[])
    .map((message) => String(message.content))
    .join("\n");
  assert.match(outcome, /Pushed canonical to coord\/export-test on GitHub/u);
  assert.match(outcome, /The work queued behind it is starting now/u);

  // And the held queue is let go, so nothing is stranded behind a push that
  // has already happened.
  await waitFor(
    async () => runtime.runCalls.length === 2,
    "the work held behind the push was never released",
  );
  const [claimed] = await runtime.store.claimSubmittedTasks(
    repositoryId,
    DEFAULT_PROJECT_ID,
  );
  assert.equal(claimed?.id, follower?.id);
  assert.equal(runtime.pushCalls.length, 1);
});

test("a held run keeps its waiting status inside the task thread", async (t) => {
  // Workflow state belongs to the task's story. The thread and task status
  // make the hold visible without interrupting the repository-wide transcript
  // with a standalone agent message.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "held-plan-visible");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    const thread = messages.find(
      (message) => message.kind === "user" && message.taskId !== undefined,
    );
    return (thread?.replies ?? []).some((reply) =>
      /Waiting on you/u.test(reply.content),
    );
  }, "the plan's thread never recorded that it was held");

  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  const thread = messages.find(
    (message) => message.kind === "user" && message.taskId !== undefined,
  );
  const announced = (thread?.replies ?? []).find((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  assert.equal(announced?.kind, "outcome");
  assert.match(announced?.content ?? "", /go ahead/u);
  assert.equal(
    messages.some((message) => /Waiting on you/u.test(message.content)),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
});

test('"go ahead" releases a review gate from the thread it was announced in', async (t) => {
  // The other hold. It could only be released through `POST /approvals/:id`,
  // a screen nobody watching a channel is on, so "go ahead" in the thread
  // fell through to the agent answering a question *about* the gate — which
  // reads exactly like it did something, while the run stayed held.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "gated-run");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const root = await runtime.store.appendChannelMessage({
    repositoryId,
    projectId: DEFAULT_PROJECT_ID,
    kind: "agent",
    authorId: `${ownerId}:anthropic`,
    content: "On it.",
  });
  await runtime.store.addChannelReply({
    repositoryId,
    messageId: root.id,
    kind: "progress",
    authorId: `${ownerId}:anthropic`,
    content: "Waiting on a human review before this can land.",
  });
  await runtime.store.setChannelMessageTask(repositoryId, root.id, "task_gated");
  const approval = await runtime.store.createApproval({
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    runId: "run_gated",
    taskId: "task_gated",
    kind: "policy_override",
    requestedBy: "claude",
    requiredRole: "admin",
    reasons: ["schema change"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root.id)}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201, JSON.stringify(go.data));

  await waitFor(async () => {
    const current = await runtime.store.getApproval(approval.id);
    return current?.status === "approved";
  }, "the gate was never released by the go-ahead");
  const decided = await runtime.store.getApproval(approval.id);
  assert.equal(decided?.decidedBy, ownerId);

  // And the thread says it happened, rather than leaving the reader to guess
  // from a run that quietly resumed.
  const thread = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.id === root.id);
  assert.match(
    (thread?.replies ?? []).map((reply) => reply.content).join("\n"),
    /Approved/u,
  );
});

test("a released hold keeps both workflow markers inside the task thread", async (t) => {
  // The release follows the hold in the same task story. Neither lifecycle
  // marker becomes a standalone group-chat message.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "released-plan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/plan @Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Waiting on you/u.test(reply.content),
      ),
    );
  }, "the thread was never told the plan was held");

  const root = (
    await runtime.store.listChannelMessages(repositoryId, ownerId)
  ).find((message) => message.kind === "user" && message.taskId !== undefined);
  const go = await owner.request(
    `${base}/messages/${encodeURIComponent(root?.id ?? "")}/replies`,
    { method: "POST", body: { content: "go ahead" } },
  );
  assert.equal(go.status, 201, JSON.stringify(go.data));

  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Go-ahead received/u.test(reply.content),
      ),
    );
  }, "the thread was never told the hold had been released");

  // Exactly one ordered pair in the thread, and neither status in the room.
  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    messages.some((message) =>
      /Waiting on you|Go-ahead received/u.test(message.content),
    ),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
  const updatedRoot = messages.find((message) => message.id === root?.id);
  const replies = updatedRoot?.replies ?? [];
  assert.equal(
    replies.filter((reply) => /Waiting on you/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  const held = replies.findIndex((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  const released = replies.findIndex((reply) =>
    /Go-ahead received/u.test(reply.content),
  );
  assert.ok(released > held, "the release did not follow the hold");
});

test("a gate's hold and release stay ordered and deduplicated in its thread", async (t) => {
  // Two ways in and one way out. The audit stream is polled rather than
  // delivered once, and a run can ask for a second gate while the first is
  // still up — both would put the same sentence in the thread twice, which
  // reads as two separate things waiting on the reader. And a reviewer who
  // clears the gate from the Approvals screen never touches the thread, so
  // the withdrawal has to be read from the stream both routes report to.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "gate-withdrawn");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const posted = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) rework the retry loop" },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const taskId = (await runtime.store.listSubmittedTasks({ repositoryId }))[0]
    ?.id;
  assert.ok(taskId !== undefined);

  const gate = {
    projectId: DEFAULT_PROJECT_ID,
    repositoryId,
    approvalId: "approval_gate",
    requiredRole: "admin",
  };
  await runtime.store.appendAudit(undefined, {
    type: "approval_requested",
    taskId,
    data: gate,
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Waiting on you/u.test(reply.content),
      ),
    );
  }, "the thread was never told the run was gated");

  // Asked for again while the first is still up: still one line.
  await runtime.store.appendAudit(undefined, {
    type: "approval_requested",
    taskId,
    data: gate,
  });
  await runtime.store.appendAudit(undefined, {
    type: "approval_decided",
    taskId,
    data: { ...gate, status: "approved", actorId: ownerId },
  });
  await waitFor(async () => {
    const messages = await runtime.store.listChannelMessages(
      repositoryId,
      ownerId,
    );
    return messages.some((message) =>
      (message.replies ?? []).some((reply) =>
        /Go-ahead received/u.test(reply.content),
      ),
    );
  }, "the thread was never told the gate had been cleared");

  const messages = await runtime.store.listChannelMessages(
    repositoryId,
    ownerId,
  );
  assert.equal(
    messages.some((message) =>
      /Waiting on you|Go-ahead received/u.test(message.content),
    ),
    false,
    JSON.stringify(messages.map((message) => message.content)),
  );
  const thread = messages.find((message) => message.taskId === taskId);
  const replies = thread?.replies ?? [];
  assert.equal(
    replies.filter((reply) => /Waiting on you/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  assert.equal(
    replies.filter((reply) => /Go-ahead received/u.test(reply.content)).length,
    1,
    JSON.stringify(replies.map((reply) => reply.content)),
  );
  const held = replies.findIndex((reply) =>
    /Waiting on you/u.test(reply.content),
  );
  const released = replies.findIndex((reply) =>
    /Go-ahead received/u.test(reply.content),
  );
  assert.ok(released > held, "the release did not follow the hold");
});

test("a channel's chosen model and reasoning level travel to the task", async (t) => {
  // The pickers beside an agent in the roster wrote to a table nothing read:
  // name and role reached the dispatch, model and effort were stored and
  // dropped. Choosing a model moved a control and changed nothing about how
  // the run was performed, which is the one thing a model picker is for.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const session = await bootstrap(owner);
  const ownerId = session.user.id;
  const repo = await invitableRepository(owner, "picked-model");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repo}/channel`;
  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repo);
  runtime.chatAnswer.text = "On it.";

  const chosen = await owner.request(
    `${base}/agents/${encodeURIComponent(`${ownerId}:anthropic`)}`,
    { method: "POST", body: { model: "claude-opus-5", effort: "max" } },
  );
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));

  const mention = `Claude (${String(session.user.displayName).split(" ")[0]})`;
  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: `@${mention} raise the retry ceiling` },
      })
    ).status,
    201,
  );
  await waitFor(
    async () => runtime.submittedTasks.length > 0,
    "the mention never dispatched a task",
  );
  assert.equal(runtime.submittedTasks[0]?.model, "claude-opus-5");
  assert.equal(runtime.submittedTasks[0]?.effort, "max");
  // And onto the row the runner actually reads when it builds the adapter.
  const [task] = await runtime.store.listSubmittedTasks({ repositoryId: repo });
  assert.equal(task?.model, "claude-opus-5");
  assert.equal(task?.effort, "max");
});

test("an unrelated mention does not run somebody's held plan", async (t) => {
  // The approval that comes *before* the work is paid for is the only one of
  // its kind in the system, and it was being spent by strangers. A held plan
  // sat in `submitted` — the status every lease query selects on — and
  // `leaseNextTask` hands out the oldest queued row in the repository, not the
  // one the caller had in mind. So the next person to mention any agent in the
  // channel fired `runRepository`, which leased the older held plan and ran
  // it, against its author's credential, with nobody having said go.
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const ownerId = bootstrapped.user.id;
  const repositoryId = await invitableRepository(owner, "held-plan");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(ownerId, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: "/plan @Claude (Owner) rewrite the auth module" },
      })
    ).status,
    201,
  );
  const held = (await runtime.store.listSubmittedTasks({ repositoryId }))[0];
  assert.equal(held?.status, "planned");

  // Somebody else's ordinary request, in the same channel, later.
  assert.equal(
    (
      await owner.request(`${base}/messages`, {
        method: "POST",
        body: { content: "@Claude (Owner) fix the typo in the README" },
      })
    ).status,
    201,
  );
  await waitFor(
    async () =>
      (await runtime.store.listSubmittedTasks({ repositoryId })).length === 2,
    "the second mention never dispatched",
  );

  // The queue may hand out the typo fix. It must not hand out the plan: a
  // lease naming the held task is the bypass itself.
  const worker = await runtime.store.registerWorker({
    userId: ownerId,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "queue-probe",
    adapters: [],
    version: "1",
  });
  const leased = await runtime.store.leaseNextTask({
    workerId: worker.id,
    repositoryId,
    baseRevision: "rev_1",
    ttlMs: 60_000,
  });
  assert.notEqual(
    leased?.task.id,
    held?.id,
    "a held plan was leased without anybody approving it",
  );
  assert.equal(
    (await runtime.store.listSubmittedTasks({ repositoryId })).find(
      (task) => task.id === held?.id,
    )?.status,
    "planned",
    "the held plan left the held status without an approval",
  );
});

test("a slash inside a sentence is left alone, and /help answers", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "slash-prose");
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}/channel`;

  runtime.chatConnections.set(bootstrapped.user.id, [
    { provider: "anthropic", visibility: "org" },
  ]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const help = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "/help" },
  });
  assert.equal(help.status, 201);
  const listed = await owner.request(`${base}/messages`);
  assert.match(
    (listed.data.messages as any[]).map((m) => m.content).join("\n"),
    /\/plan/u,
  );
  assert.match(
    (listed.data.messages as any[]).map((m) => m.content).join("\n"),
    /\/push\b/u,
  );
  // The picker reads the same table the channel parses by, so they cannot
  // offer and accept different things.
  assert.ok(
    (listed.data.slashCommands as any[]).some((entry) => entry.name === "plan"),
    JSON.stringify(listed.data.slashCommands),
  );
  assert.ok(
    (listed.data.slashCommands as any[]).some((entry) => entry.name === "push"),
    JSON.stringify(listed.data.slashCommands),
  );
  // /help answers the channel; it does not become work for an agent.
  assert.equal(runtime.submittedTasks.length, 0);

  // A path is a sentence, not syntax.
  const prose = await owner.request(`${base}/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) please fix /usr/bin/env handling" },
  });
  assert.equal(prose.status, 201);
  assert.equal(runtime.submittedTasks.length, 1);
  assert.match(runtime.submittedTasks[0]?.objective ?? "", /usr\/bin\/env/u);
});
