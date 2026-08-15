import assert from "node:assert/strict";
import test from "node:test";

import { TaskCancellationRegistry } from "@coord/coordinator";
import {
  DEFAULT_ORGANIZATION_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";

import { cancelTasks } from "./commands.js";

/**
 * The stop path, at the seam every caller shares: the channel command, the
 * thread command and the dashboard button all land on `cancelTasks`, so what
 * it settles — rows, leases, live sessions, audit — is pinned here once.
 */

const BASE_REVISION = "c".repeat(40);

async function harness() {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo",
    path: "/nowhere/canonical.git",
    branch: "main",
  });
  const owner = await store.createUser({
    email: "owner@example.invalid",
    displayName: "Owner",
    passwordDigest: "unused",
  });
  const worker = await store.registerWorker({
    userId: owner.id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "test-runner",
    adapters: ["codex"],
    version: "0.1.0",
  });
  const submit = async (
    objective: string,
    options: { agentId?: string; planOnly?: boolean } = {},
  ) =>
    await store.submitTask({
      repositoryId: "repo",
      objective,
      agentId: options.agentId ?? "builder",
      validationCommands: [],
      ...(options.planOnly === true ? { planOnly: true } : {}),
    });
  return { store, workerId: worker.id, submit };
}

test("a repository-wide stop settles rows, lease, live session, and audit", async () => {
  const { store, workerId, submit } = await harness();

  // Oldest first, so the lease below lands on this one.
  const running = await submit("running work");
  const leased = await store.leaseNextTask({
    workerId,
    repositoryId: "repo",
    baseRevision: BASE_REVISION,
    ttlMs: 60_000,
  });
  assert.equal(leased?.task.id, running.id);

  const queued = await submit("queued work");
  const held = await submit("held plan", { planOnly: true });

  // A conversational turn waiting for its person: not part of a sweep.
  const conversational = await submit("open conversation");
  await store.claimSubmittedTasks("repo");
  await store.openSubmittedTask(conversational.id);
  // Claiming for the open task also claimed `queued`; put it back.
  await store.retrySubmittedTask(queued.id);

  const aborted: Array<{ taskId: string; reason: string }> = [];
  const cancellations = new TaskCancellationRegistry();
  cancellations.register(running.id, async (reason) => {
    aborted.push({ taskId: running.id, reason });
  });

  const reports = await cancelTasks(store, {
    repositoryId: "repo",
    reason: "Stopped from the channel",
    actorId: "user-1",
    cancellations,
  });

  assert.deepEqual(
    reports.map((entry) => [entry.id, entry.was]).sort(),
    [
      [held.id, "held"],
      [queued.id, "queued"],
      [running.id, "running"],
    ].sort(),
  );

  // The live session was aborted with the canceller's own words.
  assert.deepEqual(aborted, [
    { taskId: running.id, reason: "Stopped from the channel" },
  ]);

  // Every stopped row is terminal; the open conversation is untouched.
  const byId = new Map(
    (await store.listSubmittedTasks({ repositoryId: "repo" })).map((task) => [
      task.id,
      task.status,
    ]),
  );
  assert.equal(byId.get(running.id), "cancelled");
  assert.equal(byId.get(queued.id), "cancelled");
  assert.equal(byId.get(held.id), "cancelled");
  assert.equal(byId.get(conversational.id), "open");

  // The lease is settled — and settling it did not resurrect the row, which
  // is what the cancel-before-release order guarantees.
  const leases = await store.listWorkLeases({ repositoryId: "repo" });
  assert.equal(leases[0]?.status, "released");
  assert.equal(byId.get(running.id), "cancelled");

  // The audit trail is what the channel narrates from: one event per task.
  const events = await store.listAuditEvents({ types: ["task_cancelled"] });
  assert.deepEqual(
    events.map((entry) => entry.event.taskId).sort(),
    [held.id, queued.id, running.id].sort(),
  );
  assert.equal(
    (events[0]?.event.data as Record<string, unknown>)["reason"],
    "Stopped from the channel",
  );
});

test("an agent-scoped stop leaves the other agents' work alone", async () => {
  const { store, submit } = await harness();
  const mine = await submit("mine", { agentId: "builder" });
  const theirs = await submit("theirs", { agentId: "reviewer" });

  const reports = await cancelTasks(store, {
    repositoryId: "repo",
    agentId: "builder",
    reason: "Stopped from the channel",
  });

  assert.deepEqual(
    reports.map((entry) => entry.id),
    [mine.id],
  );
  const byId = new Map(
    (await store.listSubmittedTasks({ repositoryId: "repo" })).map((task) => [
      task.id,
      task.status,
    ]),
  );
  assert.equal(byId.get(mine.id), "cancelled");
  assert.equal(byId.get(theirs.id), "submitted");
});

test("naming an open conversation stops it, though no sweep would", async () => {
  const { store, submit } = await harness();
  const conversational = await submit("open conversation");
  await store.claimSubmittedTasks("repo");
  await store.openSubmittedTask(conversational.id);

  const reports = await cancelTasks(store, {
    repositoryId: "repo",
    taskIds: [conversational.id],
    reason: "Stopped from its thread",
  });

  assert.deepEqual(
    reports.map((entry) => [entry.id, entry.was]),
    [[conversational.id, "waiting"]],
  );
});

test("a task that settled first is skipped, not fought over", async () => {
  const { store, submit } = await harness();
  const finished = await submit("already done");
  await store.claimSubmittedTasks("repo");
  await store.completeSubmittedTask(finished.id, "integrated");

  const reports = await cancelTasks(store, {
    repositoryId: "repo",
    taskIds: [finished.id],
    reason: "Stopped from its thread",
  });

  assert.deepEqual(reports, []);
  assert.equal(
    (await store.listAuditEvents({ types: ["task_cancelled"] })).length,
    0,
  );
  const [row] = await store.listSubmittedTasks({ repositoryId: "repo" });
  assert.equal(row?.status, "integrated");
});
