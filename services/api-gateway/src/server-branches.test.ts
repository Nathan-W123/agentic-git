/**
 * A channel that is a branch, over HTTP.
 *
 * Stage one is that a work channel has a branch and refuses to adopt one it
 * did not create; stage two is that work dispatched inside it is commissioned
 * against that branch and work dispatched anywhere else is not. Both are
 * asserted here at the boundary a browser actually talks to, because both are
 * the kind of thing that typechecks perfectly while sending every task to
 * canonical.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROJECT_ID } from "@coord/persistence";

import {
  TestClient,
  addColleague,
  bootstrap,
  invitableRepository,
  joinAllConnectedAgents,
  startRuntime,
} from "./test-harness.js";

/** `/projects/…/repositories/…`, which every path below hangs off. */
function repositoryBase(repositoryId: string): string {
  return `/api/v1/projects/${DEFAULT_PROJECT_ID}/repositories/${repositoryId}`;
}

test("a work channel gets a branch, and never adopts one it did not make", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "branch-repo");
  const base = repositoryBase(repositoryId);

  // An ordinary room. No branch — most channels are conversations, and a
  // branch for one would be a branch nothing ever commits to.
  const talking = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "design", visibility: "public" },
  });
  assert.equal(talking.status, 201, JSON.stringify(talking.data));
  assert.equal(talking.data.channel.branch, undefined);
  assert.equal(runtime.branches.size, 0);

  // A work channel. The branch is derived from the handle, so the room and
  // the branch are one name rather than two that can drift.
  const working = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "Login redirect", visibility: "public", branch: true },
  });
  assert.equal(working.status, 201, JSON.stringify(working.data));
  assert.equal(working.data.channel.slug, "login-redirect");
  assert.equal(working.data.channel.branch, "kumi/login-redirect");
  assert.ok(runtime.branches.has(`${repositoryId}\u0000kumi/login-redirect`));

  // It reads back through the list, which is what the sidebar draws from.
  const listed = await owner.request(`${base}/channels`);
  assert.equal(listed.status, 200);
  const rows = listed.data.channels as Array<Record<string, unknown>>;
  assert.equal(
    rows.find((row) => row["slug"] === "login-redirect")?.["branch"],
    "kumi/login-redirect",
  );
  assert.equal(rows.find((row) => row["slug"] === "design")?.["branch"], undefined);
  assert.equal(rows.find((row) => row["slug"] === "general")?.["branch"], undefined);

  // The name is taken, so this is refused as a channel before it ever
  // reaches the branch — the ordinary duplicate-room path, unchanged.
  const twice = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "login-redirect", branch: true },
  });
  assert.equal(twice.status, 409);
  assert.equal(twice.data.error.code, "channel_exists");

  // A branch that exists without a channel is the case that matters: it has
  // commits on it nobody in this room reviewed, and adopting it would put
  // them inside this channel's pull request as though they were its work.
  runtime.branches.set(`${repositoryId}\u0000kumi/imported`, {
    conflicts: [],
    merged: false,
  });
  const squatted = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "imported", branch: true },
  });
  assert.equal(squatted.status, 409, JSON.stringify(squatted.data));
  assert.equal(squatted.data.error.code, "branch_exists");
  assert.match(squatted.data.error.message, /kumi\/imported/u);
  // And no channel was stored for it, so the refusal is total rather than a
  // room left behind pointing at somebody else's branch.
  const afterSquat = await owner.request(`${base}/channels`);
  assert.equal(
    (afterSquat.data.channels as Array<Record<string, unknown>>).some(
      (row) => row["slug"] === "imported",
    ),
    false,
  );
});

test("a work channel cannot be renamed, and deleting one drops its branch", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "branch-life-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "retry-backoff", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;
  const branchKey = `${repositoryId}\u0000kumi/retry-backoff`;
  assert.ok(runtime.branches.has(branchKey));

  // A rename would leave #new-name working `kumi/retry-backoff`, which reads
  // as a bug everywhere either name is shown.
  const renamed = await owner.request(`${base}/channels/${channelId}`, {
    method: "PATCH",
    body: { name: "retry-jitter" },
  });
  assert.equal(renamed.status, 409, JSON.stringify(renamed.data));
  assert.equal(renamed.data.error.code, "branch_channel");

  // Visibility is not the name, and changing it is still allowed.
  const hidden = await owner.request(`${base}/channels/${channelId}`, {
    method: "PATCH",
    body: { visibility: "private" },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
  assert.equal(hidden.data.channel.visibility, "private");
  assert.equal(hidden.data.channel.branch, "kumi/retry-backoff");

  // Deleting the room takes the branch with it: work abandoned rather than
  // merged must not leave a name nothing owns that nothing can reuse.
  const removed = await owner.request(`${base}/channels/${channelId}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(runtime.branches.has(branchKey), false);

  // Which is exactly what makes the name usable again.
  const again = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "retry-backoff", visibility: "public", branch: true },
  });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(again.data.channel.branch, "kumi/retry-backoff");
});

test("work dispatched in a work channel is commissioned against its branch", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "branch-dispatch-repo");
  const base = repositoryBase(repositoryId);

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);

  const working = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "session-expiry", visibility: "public", branch: true },
  });
  assert.equal(working.status, 201, JSON.stringify(working.data));
  const workChannelId = working.data.channel.id as string;
  // An agent is assigned per room, and `joinAllConnectedAgents` only reaches
  // `#general`. Without this the mention below simply does not resolve in the
  // work channel, and the test would pass by dispatching nothing.
  await runtime.store.setChannelAgentMember(
    repositoryId,
    bootstrapped.user.id,
    "anthropic",
    true,
    workChannelId,
  );

  // Two rooms, one repository, one agent. The only thing that differs is
  // where it was said, and that is what has to decide where the work lands.
  const inChannel = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: {
      channelId: workChannelId,
      content: "@Claude (Owner) shorten the session timeout",
    },
  });
  assert.equal(inChannel.status, 201, JSON.stringify(inChannel.data));

  const inGeneral = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { content: "@Claude (Owner) add a logout button to the header" },
  });
  assert.equal(inGeneral.status, 201, JSON.stringify(inGeneral.data));

  assert.equal(runtime.submittedTasks.length, 2, JSON.stringify(runtime.submittedTasks));
  const fromChannel = runtime.submittedTasks.find((task) =>
    task.objective.includes("session timeout"),
  );
  const fromGeneral = runtime.submittedTasks.find((task) =>
    task.objective.includes("logout button"),
  );
  assert.equal(fromChannel?.branch, "kumi/session-expiry");
  // Absent, not the repository's branch spelled out: absent is what every
  // task written before work channels existed meant, and the stores read it
  // as "the repository's own".
  assert.equal(fromGeneral?.branch, undefined);

  // And it is on the stored row, not only in the operation's arguments — the
  // lease reads the row, and a branch that stopped at the boundary would
  // send the work to canonical anyway.
  const stored = await runtime.store.listSubmittedTasks({ repositoryId });
  assert.equal(stored.length, 2);
  assert.equal(
    stored.filter((task) => task.branch === "kumi/session-expiry").length,
    1,
  );
  assert.equal(stored.filter((task) => task.branch === undefined).length, 1);
});

test("a deployment that cannot make branches says so instead of storing one", async (t) => {
  const runtime = await startRuntime(t, { withoutBranches: true });
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "no-branch-repo");
  const base = repositoryBase(repositoryId);

  const refused = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "cannot-work", branch: true },
  });
  assert.equal(refused.status, 501, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, "not_supported");

  // Nothing was stored. A channel that named a branch nothing can check out
  // would take every task dispatched in it somewhere that does not exist.
  const listed = await owner.request(`${base}/channels`);
  assert.equal(
    (listed.data.channels as Array<Record<string, unknown>>).some(
      (row) => row["slug"] === "cannot-work",
    ),
    false,
  );

  // An ordinary channel is unaffected: no branch was ever wanted, so no
  // capability is missing.
  const talking = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "cannot-work", visibility: "public" },
  });
  assert.equal(talking.status, 201, JSON.stringify(talking.data));
  assert.equal(talking.data.channel.branch, undefined);
});

test("a work channel's branch reads back as a pull request, and merges once", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "review-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "search-ranking", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;

  // The review: what the branch has, taken from the merge base, and whether
  // the person asking may land it.
  const review = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.equal(review.data.branch, "kumi/search-ranking");
  assert.equal(review.data.merged, false);
  // What it would land on, by name. The comparison knows the base as a
  // revision, and every sentence the panel says about a conflict has to name
  // the branch the conflict is with — "conflicts with b3f1a90" names nothing
  // anybody can act on.
  assert.equal(review.data.base, "main");
  assert.equal(review.data.ahead, 1);
  assert.deepEqual(review.data.files, ["src/login.ts"]);
  assert.equal(typeof review.data.patch, "string");
  assert.deepEqual(review.data.conflicts, []);
  assert.equal(review.data.canMerge, true);

  // Merging lands it, closes the channel, and says so in the room.
  const merged = await owner.request(
    `${base}/channels/${channelId}/branch/merge`,
    { method: "POST", body: {} },
  );
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.equal(merged.data.merged, true);
  assert.deepEqual(runtime.mergedBranches, ["kumi/search-ranking"]);
  assert.equal(typeof merged.data.channel.mergedAt, "string");

  const said = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (said.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        /Merged `kumi\/search-ranking`/u.test(String(message["content"])),
    ),
    true,
    JSON.stringify(said.data.messages),
  );

  // Read again, it is finished rather than empty: the branch is gone, so
  // anything but "this landed" would describe a branch that does not exist.
  const after = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(after.status, 200);
  assert.equal(after.data.merged, true);
  assert.equal(after.data.mergedAt, merged.data.channel.mergedAt);

  // And it cannot merge twice — the second one would put an empty merge
  // commit on canonical for a branch nothing points at.
  const again = await owner.request(
    `${base}/channels/${channelId}/branch/merge`,
    { method: "POST", body: {} },
  );
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal(again.data.error.code, "already_merged");
  assert.deepEqual(runtime.mergedBranches, ["kumi/search-ranking"]);

  // The room is closed. Its composer is gone in the list, and the write path
  // agrees with the list rather than 403ing a composer it drew.
  const listed = await owner.request(`${base}/channels`);
  const row = (listed.data.channels as Array<Record<string, unknown>>).find(
    (candidate) => candidate["id"] === channelId,
  );
  assert.equal(row?.["canPost"], false);
  assert.equal(typeof row?.["mergedAt"], "string");
  const refused = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId, content: "one more thing" },
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
});

test("a branch that conflicts refuses rather than resolving", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "conflict-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "risky", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;
  runtime.branches.set(`${repositoryId}\u0000kumi/risky`, {
    conflicts: ["src/login.ts"],
    merged: false,
  });

  // The review says so before anybody presses anything.
  const review = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(review.status, 200);
  assert.deepEqual(review.data.conflicts, ["src/login.ts"]);

  // And the merge refuses rather than inventing a resolution: code nobody
  // reviewed must not reach canonical under a review that never saw it.
  const merged = await owner.request(
    `${base}/channels/${channelId}/branch/merge`,
    { method: "POST", body: {} },
  );
  assert.equal(merged.status, 409, JSON.stringify(merged.data));
  assert.equal(merged.data.error.code, "merge_conflict");
  assert.deepEqual(merged.data.error.conflicts, ["src/login.ts"]);
  assert.deepEqual(runtime.mergedBranches, []);

  // The channel is not closed by a merge that did not happen.
  const listed = await owner.request(`${base}/channels`);
  const row = (listed.data.channels as Array<Record<string, unknown>>).find(
    (candidate) => candidate["id"] === channelId,
  );
  assert.equal(row?.["mergedAt"], undefined);
  assert.equal(row?.["canPost"], true);

  // Refreshing reports the same conflicts into the room, which is the only
  // warning anybody gets before the merge refuses for the same reason.
  const refreshed = await owner.request(
    `${base}/channels/${channelId}/branch/refresh`,
    { method: "POST", body: {} },
  );
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.merged, false);
  const said = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (said.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        /Could not bring the repository's latest/u.test(
          String(message["content"]),
        ),
    ),
    true,
  );
});

test("a merged channel ships to GitHub, and only once merged", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ship-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "checkout-flow", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;

  // The two gates are two gates, in that order: Kumi reviews the branch into
  // the repository, and GitHub reviews the repository into main. Shipping
  // before the first one has happened is asking GitHub to review work Kumi
  // has not accepted.
  const early = await owner.request(
    `${base}/channels/${channelId}/branch/ship`,
    { method: "POST", body: {} },
  );
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.equal(early.data.error.code, "not_merged");
  // Length rather than `deepEqual` against `[]`: the empty literal narrows
  // the array's element type to `never`, and every later read of a shipped
  // entry stops typechecking.
  assert.equal(runtime.shippedChannels.length, 0);

  const merged = await owner.request(
    `${base}/channels/${channelId}/branch/merge`,
    { method: "POST", body: {} },
  );
  assert.equal(merged.status, 200, JSON.stringify(merged.data));

  // Merged and not shipped: the review offers the button and says so.
  const waiting = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.data.merged, true);
  assert.equal(waiting.data.pullRequestUrl, undefined);
  assert.equal(waiting.data.canShip, true);

  const shipped = await owner.request(
    `${base}/channels/${channelId}/branch/ship`,
    { method: "POST", body: {} },
  );
  assert.equal(shipped.status, 200, JSON.stringify(shipped.data));
  assert.equal(shipped.data.outcome, "done");
  assert.equal(runtime.shippedChannels.length, 1);
  // The branch it pushes is the channel's own, so GitHub shows one pull
  // request per channel rather than one per push under a generated name.
  assert.equal(runtime.shippedChannels[0]?.branch, "kumi/checkout-flow");
  assert.equal(runtime.shippedChannels[0]?.title, "#checkout-flow");

  // The link is on the channel, not just in the response: it is what the
  // review surface links to on every later read.
  const after = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(after.data.pullRequestUrl, "https://github.com/acme/app/pull/1");
  assert.equal(typeof after.data.shippedAt, "string");
  const listed = await owner.request(`${base}/channels`);
  assert.equal(
    (listed.data.channels as Array<Record<string, unknown>>).find(
      (row) => row["id"] === channelId,
    )?.["pullRequestUrl"],
    "https://github.com/acme/app/pull/1",
  );

  // And the room is told where its work went.
  const said = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (said.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        String(message["content"]).includes("github.com/acme/app/pull/1"),
    ),
    true,
  );
});

test("shipping refused leaves the channel un-shipped and says why", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "unshippable-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "no-remote", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;
  await owner.request(`${base}/channels/${channelId}/branch/merge`, {
    method: "POST",
    body: {},
  });

  // A refusal is an outcome, not an error: the merge already landed, and the
  // reason — no remote, no connected account, a token without write access —
  // is something the person reading it can fix.
  runtime.shipOutcome.outcome = "refused";
  runtime.shipOutcome.explanation =
    "You haven't connected GitHub, so there is no account to ship as.";
  const refused = await owner.request(
    `${base}/channels/${channelId}/branch/ship`,
    { method: "POST", body: {} },
  );
  assert.equal(refused.status, 200, JSON.stringify(refused.data));
  assert.equal(refused.data.outcome, "refused");
  assert.match(refused.data.explanation, /haven't connected GitHub/u);

  // Nothing was recorded. A channel that links to a pull request nobody
  // opened has stopped asking for the one thing it still needs.
  const after = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(after.data.pullRequestUrl, undefined);
  assert.equal(after.data.shippedAt, undefined);
  assert.equal(after.data.canShip, true);

  // The reason is in the room, where the person who pressed the button is.
  const said = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (said.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        /haven't connected GitHub/u.test(String(message["content"])),
    ),
    true,
  );

  // Once fixed, the same button works — the channel was left in a state that
  // could still ship, which is the whole point of not recording the failure.
  runtime.shipOutcome.outcome = "done";
  const retried = await owner.request(
    `${base}/channels/${channelId}/branch/ship`,
    { method: "POST", body: {} },
  );
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.outcome, "done");
  const shipped = await owner.request(`${base}/channels/${channelId}/branch`);
  assert.equal(typeof shipped.data.pullRequestUrl, "string");
});

test("a developer cannot ship, and a deployment without GitHub says so", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "ship-authz-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "release", visibility: "public", branch: true },
  });
  const channelId = created.data.channel.id as string;
  await owner.request(`${base}/channels/${channelId}/branch/merge`, {
    method: "POST",
    body: {},
  });

  // Shipping asks a second set of reviewers to take work Kumi already
  // accepted, and it publishes under the caller's own GitHub account. Same
  // weight as merging, same permission.
  const colleague = await addColleague(runtime, "developer-ship@example.com");
  const refused = await colleague.client.request(
    `${base}/channels/${channelId}/branch/ship`,
    { method: "POST", body: {} },
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.deepEqual(runtime.shippedChannels, []);
  // And the button is not drawn for them either.
  const reads = await colleague.client.request(
    `${base}/channels/${channelId}/branch`,
  );
  assert.equal(reads.status, 200, JSON.stringify(reads.data));
  assert.equal(reads.data.canShip, false);
});

test("/push in an unmerged work channel names the gate it has to pass", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "push-gate-repo");
  const base = repositoryBase(repositoryId);

  const created = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "half-done", visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;

  // `/push` publishes the repository's own branch, and this channel's work is
  // not on it yet. Pushing would publish somebody else's work under this
  // channel's name and leave this channel's exactly where it was.
  const pushed = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { channelId, content: "/push" },
  });
  assert.equal(pushed.status, 201, JSON.stringify(pushed.data));
  assert.equal(runtime.pushCalls.length, 0);
  const said = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (said.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        /Review and merge this channel first/u.test(String(message["content"])),
    ),
    true,
    JSON.stringify(said.data.messages),
  );

  // #general has no branch, so nothing about it changed.
  const general = await owner.request(`${base}/channel/messages`, {
    method: "POST",
    body: { content: "/push" },
  });
  assert.equal(general.status, 201, JSON.stringify(general.data));
  assert.equal(runtime.pushCalls.length, 1);
});

test("a conversation channel has no branch to review, and a developer cannot merge", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "review-authz-repo");
  const base = repositoryBase(repositoryId);

  const talking = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "watercooler", visibility: "public" },
  });
  assert.equal(talking.status, 201, JSON.stringify(talking.data));
  const conversation = await owner.request(
    `${base}/channels/${talking.data.channel.id}/branch`,
  );
  assert.equal(conversation.status, 409, JSON.stringify(conversation.data));
  assert.equal(conversation.data.error.code, "not_a_branch");

  const work = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "shipping", visibility: "public", branch: true },
  });
  assert.equal(work.status, 201, JSON.stringify(work.data));
  const channelId = work.data.channel.id as string;

  // A developer may work in the channel and may bring the repository's latest
  // into it — that touches only this branch. Landing on canonical is the
  // most consequential write in the system, and `review` is admin-and-up.
  const colleague = await addColleague(runtime, "developer-review@example.com");
  const reads = await colleague.client.request(
    `${base}/channels/${channelId}/branch`,
  );
  assert.equal(reads.status, 200, JSON.stringify(reads.data));
  assert.equal(
    reads.data.canMerge,
    false,
    "the button must not be drawn for somebody the server would refuse",
  );

  const refreshes = await colleague.client.request(
    `${base}/channels/${channelId}/branch/refresh`,
    { method: "POST", body: {} },
  );
  assert.equal(refreshes.status, 200, JSON.stringify(refreshes.data));

  const merges = await colleague.client.request(
    `${base}/channels/${channelId}/branch/merge`,
    { method: "POST", body: {} },
  );
  assert.equal(merges.status, 403, JSON.stringify(merges.data));
  assert.deepEqual(runtime.mergedBranches, []);
});

test("only somebody who can manage the project may open a work channel", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "branch-authz-repo");
  const base = repositoryBase(repositoryId);

  // A developer can post in every room and cannot create one, branch or no
  // branch — the rule this route has always enforced, restated here so a
  // branch never becomes a way past it. Asserted on the fixture's branch map
  // as well as the status: a route that refused after cutting the branch
  // would answer 403 and still leave a branch behind.
  const colleague = await addColleague(runtime, "developer-branch@example.com");
  const refused = await colleague.client.request(`${base}/channels`, {
    method: "POST",
    body: { name: "sneaky", branch: true },
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(runtime.branches.size, 0);
});

/* ------------------------------------------------------- reviewing it ---- */

/**
 * Opens a work channel and answers with its id and the path its branch
 * surface hangs off, which every review test below needs first.
 */
async function workChannel(
  client: TestClient,
  base: string,
  name: string,
): Promise<{ channelId: string; branchPath: string }> {
  const created = await client.request(`${base}/channels`, {
    method: "POST",
    body: { name, visibility: "public", branch: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const channelId = created.data.channel.id as string;
  return { channelId, branchPath: `${base}/channels/${channelId}/branch` };
}

test("the review says what the branch is made of, not just what it holds", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "commits-repo");
  const base = repositoryBase(repositoryId);
  const { branchPath } = await workChannel(owner, base, "search-ranking");

  runtime.branchCommits.push({
    revision: "2".repeat(40),
    subject: "Take the ranking out of the request path",
    author: "Codex (Nathan)",
    createdAt: "2026-02-02T11:00:00.000Z",
  });

  const review = await owner.request(branchPath);
  assert.equal(review.status, 200, JSON.stringify(review.data));
  // The commits are the history a reviewer reads before the diff — who wrote
  // what, in order. They are carried through the route rather than derived
  // in the browser from the patch, which cannot know them.
  const commits = review.data.commits as Array<Record<string, unknown>>;
  assert.equal(commits.length, 2);
  assert.equal(commits[1]?.["subject"], "Take the ranking out of the request path");
  assert.equal(commits[1]?.["author"], "Codex (Nathan)");
  assert.equal(commits[0]?.["revision"], "1".repeat(40));
  // And the head, which every comment below is stamped against.
  assert.equal(review.data.head, "c".repeat(40));
});

test("a review comment is a message in the room, anchored to a line", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "comment-repo");
  const base = repositoryBase(repositoryId);
  const { channelId, branchPath } = await workChannel(owner, base, "retry-backoff");

  const posted = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "This retries forever if the clock goes backwards.",
      path: "src/login.ts",
      line: 12,
      revision: "c".repeat(40),
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  assert.deepEqual(posted.data.message.anchor, {
    path: "src/login.ts",
    line: 12,
    revision: "c".repeat(40),
  });

  // It is in the transcript, not in a comment table beside it. That is the
  // whole design: the room is the pull request's conversation, so a comment
  // moves the unread count, arrives over the socket and threads like
  // anything else somebody said.
  const messages = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(messages.status, 200);
  const inRoom = (messages.data.messages as Array<Record<string, unknown>>).find(
    (message) => message["id"] === posted.data.message.id,
  );
  assert.equal(
    (inRoom?.["anchor"] as Record<string, unknown> | undefined)?.["line"],
    12,
  );

  // And it comes back on the review, marked as being about the diff on the
  // screen rather than about some earlier one.
  const review = await owner.request(branchPath);
  const comments = review.data.comments as Array<Record<string, unknown>>;
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.["current"], true);
  assert.equal(
    comments[0]?.["content"],
    "This retries forever if the clock goes backwards.",
  );
});

test("a comment pointing at a line that moved, or a file that never changed, is refused", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "stale-comment-repo");
  const base = repositoryBase(repositoryId);
  const { channelId, branchPath } = await workChannel(owner, base, "session-expiry");

  // A revision this branch never had. The line number was counted in a diff
  // that is no longer on screen, so placing it against this one would put
  // the remark on whatever happens to sit at line 12 now.
  const moved = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "Stale.",
      path: "src/login.ts",
      line: 12,
      revision: "0".repeat(40),
    },
  });
  assert.equal(moved.status, 409, JSON.stringify(moved.data));
  assert.equal(moved.data.error.code, "revision_moved");

  // A file outside the change. Anchoring there would draw a comment on a
  // diff that has no such file, so it would never be seen again.
  const elsewhere = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "Wrong file.",
      path: "src/somewhere-else.ts",
      line: 3,
      revision: "c".repeat(40),
    },
  });
  assert.equal(elsewhere.status, 400, JSON.stringify(elsewhere.data));
  assert.equal(elsewhere.data.error.code, "not_in_this_change");

  // A comment with no line at all is not a review comment.
  const unplaced = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: { content: "Nowhere.", path: "src/login.ts", revision: "c".repeat(40) },
  });
  assert.equal(unplaced.status, 400, JSON.stringify(unplaced.data));

  // None of the three left anything behind — a refusal that still posted
  // would put an unplaceable remark in the room every time somebody's page
  // was one commit out of date.
  const messages = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.equal(
    (messages.data.messages as Array<Record<string, unknown>>).filter(
      (message) => message["anchor"] !== undefined,
    ).length,
    0,
  );
});

test("mentioning an agent in a review comment dispatches the work on that branch", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  const bootstrapped = await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "comment-task-repo");
  const base = repositoryBase(repositoryId);

  runtime.chatConnections.set(bootstrapped.user.id, [{ provider: "anthropic" }]);
  await joinAllConnectedAgents(runtime, repositoryId);
  const { channelId, branchPath } = await workChannel(owner, base, "email-digest");
  // An agent is assigned per room, and `joinAllConnectedAgents` only reaches
  // `#general`. Without this the mention below resolves to nobody and the
  // test would pass by dispatching nothing.
  await runtime.store.setChannelAgentMember(
    repositoryId,
    bootstrapped.user.id,
    "anthropic",
    true,
    channelId,
  );

  const posted = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "@Claude (Owner) this retries forever if the clock goes backwards.",
      path: "src/login.ts",
      line: 12,
      revision: "c".repeat(40),
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  // The point of putting comments through the ordinary post path: a remark on
  // a line can be handed to an agent without building a second dispatcher that
  // would have to learn thread creation, roles and credentials over again.
  // This is also the thing a pull request on GitHub structurally cannot do.
  const taskIds = posted.data.taskIds as string[];
  assert.equal(taskIds.length, 1, JSON.stringify(posted.data));

  const stored = await runtime.store.listSubmittedTasks({ repositoryId });
  const task = stored.find((entry) => entry.id === taskIds[0]);
  assert.ok(task !== undefined, "the comment did not commission anything");
  // And it lands on the channel's branch, not on canonical — the comment is
  // about work in progress, so the fix belongs beside it.
  assert.equal(task?.branch, "kumi/email-digest");
  // The objective carries what was said, so the agent is working on the
  // remark rather than on the fact that a remark happened.
  assert.match(String(task?.objective), /retries forever/u);
});

test("approving is a standing answer, stamped with what was approved", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "approve-repo");
  const base = repositoryBase(repositoryId);
  const { channelId, branchPath } = await workChannel(owner, base, "payments-v2");

  const before = await owner.request(branchPath);
  assert.equal(before.data.myReview, undefined);
  assert.equal((before.data.reviews as unknown[]).length, 0);

  const approved = await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "approved", note: "Reads right, and the test covers it." },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.review.state, "approved");
  // Stamped with the head it was about. Four commits later this is still an
  // approval of something, and a reader can tell it was not this.
  assert.equal(approved.data.review.revision, "c".repeat(40));

  const after = await owner.request(branchPath);
  assert.equal(after.data.myReview, "approved");
  const reviews = after.data.reviews as Array<Record<string, unknown>>;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.["note"], "Reads right, and the test covers it.");
  assert.equal(reviews[0]?.["current"], true);

  // Said out loud. A decision made in a panel that the room never hears
  // about is a decision the rest of the conversation cannot see.
  const messages = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  assert.ok(
    (messages.data.messages as Array<Record<string, unknown>>).some(
      (message) =>
        message["kind"] === "system" &&
        String(message["content"]).includes("approved") &&
        String(message["content"]).includes("kumi/payments-v2"),
    ),
    JSON.stringify(messages.data.messages),
  );

  // Changing your mind replaces the answer rather than adding a second one.
  const changed = await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "changes_requested", note: "Actually, the retry is wrong." },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const second = await owner.request(branchPath);
  assert.equal((second.data.reviews as unknown[]).length, 1);
  assert.equal(second.data.myReview, "changes_requested");

  // And withdrawing leaves none, so the panel offers both buttons again
  // rather than showing one as pressed.
  const withdrawn = await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "withdrawn" },
  });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.data));
  assert.equal(withdrawn.data.state, null);
  const third = await owner.request(branchPath);
  assert.equal((third.data.reviews as unknown[]).length, 0);
  assert.equal(third.data.myReview, undefined);

  const nonsense = await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "lgtm" },
  });
  assert.equal(nonsense.status, 400, JSON.stringify(nonsense.data));
});

test("a review is stale once the branch moves under it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "stale-review-repo");
  const base = repositoryBase(repositoryId);
  const { branchPath } = await workChannel(owner, base, "search-ranking");

  await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "approved" },
  });
  const posted = await owner.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "Looks right here.",
      path: "src/login.ts",
      line: 4,
      revision: "c".repeat(40),
    },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));

  // The branch gains a commit. Nothing about the stored approval or the
  // stored comment changes — what changes is that neither is about what is
  // on the screen any more, and the surface has to say so rather than
  // presenting a week-old approval of different code as current.
  runtime.branchHead.revision = "f".repeat(40);

  const review = await owner.request(branchPath);
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.equal(review.data.head, "f".repeat(40));
  assert.equal(
    (review.data.reviews as Array<Record<string, unknown>>)[0]?.["current"],
    false,
  );
  assert.equal(
    (review.data.comments as Array<Record<string, unknown>>)[0]?.["current"],
    false,
  );
  // Still there, both of them: stale is a label, not a deletion. Somebody
  // has to be able to read what was said about the version before this one.
  assert.equal((review.data.reviews as unknown[]).length, 1);
  assert.equal((review.data.comments as unknown[]).length, 1);
});

test("reading and answering a review needs no more than being in the room", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "review-authz-repo");
  const base = repositoryBase(repositoryId);
  const { branchPath } = await workChannel(owner, base, "shipping");

  // A developer cannot land the branch — `review` is admin-and-up, asserted
  // above. But reviewing is the part everybody does: a surface that only
  // admins could comment on or approve would be a pull request with one
  // reviewer, which is not a review.
  const colleague = await addColleague(runtime, "reviewer@example.com");
  const commented = await colleague.client.request(`${branchPath}/comments`, {
    method: "POST",
    body: {
      content: "The backoff should be capped.",
      path: "src/login.ts",
      line: 9,
      revision: "c".repeat(40),
    },
  });
  assert.equal(commented.status, 201, JSON.stringify(commented.data));

  const answered = await colleague.client.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "changes_requested", note: "Cap the backoff." },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));

  // Both people's answers are on the branch, each attributed — one panel
  // showing what the room thinks rather than a private verdict per reader.
  await owner.request(`${branchPath}/review`, {
    method: "POST",
    body: { state: "approved" },
  });
  const review = await owner.request(branchPath);
  const reviews = review.data.reviews as Array<Record<string, unknown>>;
  assert.equal(reviews.length, 2);
  assert.equal(
    reviews.find((row) => row["userId"] === colleague.id)?.["state"],
    "changes_requested",
  );
  assert.equal(review.data.myReview, "approved");
  // And the owner sees the colleague's comment as well as their own.
  assert.equal((review.data.comments as unknown[]).length, 1);
});

/* ------------------------------------------------------------- drift ---- */

test("an open branch is brought up to date when the repository moves under it", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "drift-repo");
  const base = repositoryBase(repositoryId);
  const open_ = await workChannel(owner, base, "search-ranking");
  const talking = await owner.request(`${base}/channels`, {
    method: "POST",
    body: { name: "design", visibility: "public" },
  });
  assert.equal(talking.status, 201, JSON.stringify(talking.data));

  // Nothing has moved yet, so the sweep is silent. This is the case that runs
  // on every tick of the timer forever, and a sweep that said something here
  // would be a line in every work channel every minute.
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);
  const quiet = await owner.request(
    `${base}/channel/messages?channelId=${open_.channelId}`,
  );
  assert.equal(
    (quiet.data.messages as Array<Record<string, unknown>>).filter(
      (message) => message["kind"] === "system",
    ).length,
    0,
    JSON.stringify(quiet.data.messages),
  );

  // Canonical gains three commits. Every open branch is now three behind, and
  // that drift — not two people editing one line — is what most merge
  // conflicts actually are. So the branch is caught up while somebody is
  // still looking, rather than left to collide at the end.
  runtime.branchDrift.behind = 3;
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);

  const messages = await owner.request(
    `${base}/channel/messages?channelId=${open_.channelId}`,
  );
  const said = (messages.data.messages as Array<Record<string, unknown>>).filter(
    (message) => message["kind"] === "system",
  );
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(String(said[0]?.["content"]), /Brought the repository's latest/u);
  assert.match(String(said[0]?.["content"]), /3 commits/u);

  // The conversation has no branch, so the sweep left it alone. Refreshing one
  // would be a git call against a ref that does not exist.
  const conversation = await owner.request(
    `${base}/channel/messages?channelId=${talking.data.channel.id}`,
  );
  assert.equal(
    (conversation.data.messages as Array<Record<string, unknown>>).filter(
      (message) => message["kind"] === "system",
    ).length,
    0,
  );
});

test("a branch that cannot catch up says so once, not once a minute", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "drift-conflict-repo");
  const base = repositoryBase(repositoryId);
  const { channelId } = await workChannel(owner, base, "retry-backoff");

  runtime.branchDrift.behind = 2;
  runtime.branches.set(`${repositoryId}\u0000kumi/retry-backoff`, {
    conflicts: ["src/login.ts"],
    merged: false,
  });

  const systemLines = async (): Promise<string[]> => {
    const messages = await owner.request(
      `${base}/channel/messages?channelId=${channelId}`,
    );
    return (messages.data.messages as Array<Record<string, unknown>>)
      .filter((message) => message["kind"] === "system")
      .map((message) => String(message["content"]));
  };

  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);
  const first = await systemLines();
  assert.equal(first.length, 1, JSON.stringify(first));
  // The warning names the files, because those are what somebody has to go and
  // fix, and says what happens if nobody does.
  assert.match(String(first[0]), /src\/login\.ts/u);
  assert.match(String(first[0]), /the merge will refuse for the same reason/u);

  // The sweep runs on a timer and a conflict does not resolve itself, so the
  // second pass finds exactly the same thing. It must not say it again — a
  // room that repeated this every minute is a room nobody reads.
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);
  assert.deepEqual(await systemLines(), first);

  // A different file conflicting is different news, so it is said.
  runtime.branches.set(`${repositoryId}\u0000kumi/retry-backoff`, {
    conflicts: ["src/login.ts", "src/session.ts"],
    merged: false,
  });
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);
  const second = await systemLines();
  assert.equal(second.length, 2, JSON.stringify(second));
  assert.match(String(second[1]), /src\/session\.ts/u);
});

test("a merged channel is not swept", async (t) => {
  const runtime = await startRuntime(t);
  const owner = new TestClient(runtime.origin);
  await bootstrap(owner);
  const repositoryId = await invitableRepository(owner, "drift-merged-repo");
  const base = repositoryBase(repositoryId);
  const { channelId, branchPath } = await workChannel(
    owner,
    base,
    "checkout-flow",
  );

  const merged = await owner.request(`${branchPath}/merge`, {
    method: "POST",
    body: {},
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));

  const before = await owner.request(
    `${base}/channel/messages?channelId=${channelId}`,
  );
  const beforeCount = (
    before.data.messages as Array<Record<string, unknown>>
  ).filter((message) => message["kind"] === "system").length;

  // Put the branch back. Merging deletes it, and a sweep over a branch that
  // is not there fails at the git call and skips the room by accident — which
  // is not the same as skipping it on purpose, and stops being true the first
  // time a deployment keeps merged branches or a delete fails. What has to
  // hold is that a *finished* room is left alone whatever git still has: the
  // people in it are done, and telling them their merged work has fallen four
  // commits behind is a notice about nothing.
  runtime.branches.set(
    `${repositoryId}\u0000kumi/checkout-flow`,
    { conflicts: [], merged: true },
  );
  runtime.branchDrift.behind = 4;
  await runtime.gateway.refreshBranchesAfterMerge(repositoryId);

  const after = await owner.request(`${base}/channel/messages?channelId=${channelId}`);
  assert.equal(
    (after.data.messages as Array<Record<string, unknown>>).filter(
      (message) => message["kind"] === "system",
    ).length,
    beforeCount,
  );
});
