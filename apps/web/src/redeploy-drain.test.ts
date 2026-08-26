import assert from "node:assert/strict";
import test from "node:test";

import { drainInFlightWork } from "@coord/cli/recovery";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";

/**
 * What a redeploy does to work that is in flight.
 *
 * The control plane is replaced on every deploy, and until it said so on the
 * way out, the task an agent was mid-way through stayed `claimed` behind a
 * lease nobody was renewing: the container that came up seconds later saw a
 * live lease, left it alone, and the thread sat on its last progress line.
 * These exercise the shutdown drain against the store, which is the only part
 * of that sequence that outlives the process.
 */

/** The name the in-process runner registers itself under. */
const LOCAL_RUNNER = "in-process-runner";

async function storeWithWorker(name: string) {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo_drain",
    path: "/tmp/repo_drain.git",
    branch: "main",
  });
  const user = await store.createUser({
    email: "drain@example.com",
    displayName: "Drain",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name,
    adapters: ["generic-cli"],
    version: "in-process",
  });
  const task = await store.submitTask({
    repositoryId: "repo_drain",
    objective: "half-finished when the deploy landed",
    agentId: "generic-cli",
    validationCommands: [],
  });
  const leased = await store.leaseNextTask({
    workerId: worker.id,
    baseRevision: "0".repeat(40),
    ttlMs: 5 * 60 * 1000,
  });
  assert.ok(leased, "the fixture's task should have been leased");
  assert.equal(leased.task.id, task.id);
  return { store, task, lease: leased.lease };
}

test("shutdown hands in-flight work back to the queue", async () => {
  const { store, task, lease } = await storeWithWorker(LOCAL_RUNNER);
  const thread = await store.appendChannelMessage({
    repositoryId: "repo_drain",
    projectId: DEFAULT_PROJECT_ID,
    kind: "user",
    authorId: "user_1",
    content: "@claude ship the thing",
  });
  await store.setChannelMessageTask("repo_drain", thread.id, task.id);

  assert.deepEqual(await drainInFlightWork(store), [task.id]);

  // Queued again, immediately — not five minutes from now when the lease
  // nobody is renewing finally expires.
  assert.equal((await store.listSubmittedTasks()).at(0)?.status, "submitted");
  assert.equal((await store.getWorkLease(lease.id))?.status, "released");

  // And the room is told, so the thread is not left mid-sentence.
  const [root] = await store.listChannelMessages("repo_drain", "user_1");
  const notices = (root?.replies ?? []).filter(
    (reply) => reply.kind === "system",
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0]?.content ?? "", /restarted/u);
});

test("shutdown leaves another machine's worker holding its own work", async () => {
  const { store, task, lease } = await storeWithWorker("remote-worker");

  assert.deepEqual(await drainInFlightWork(store), []);

  assert.equal(
    (await store.listSubmittedTasks()).find((entry) => entry.id === task.id)
      ?.status,
    "claimed",
  );
  assert.equal((await store.getWorkLease(lease.id))?.status, "active");
});
