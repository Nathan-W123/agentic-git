import assert from "node:assert/strict";
import test from "node:test";

import { TaskCancellationRegistry } from "@coord/coordinator";
import {
  DEFAULT_ORGANIZATION_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";

import { cancelTasks, pauseTasks, resumeTasks } from "./commands.js";

/**
 * The stop that is meant to be undone, at the seam every caller shares.
 *
 * Everything `cancel-tasks.test.ts` pins about stopping applies here too —
 * the row, the lease, the live session, the audit — and the difference is the
 * whole of the feature: the row stays non-terminal, so the same work can be
 * put back rather than resubmitted as something new.
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
    options: { planOnly?: boolean } = {},
  ) =>
    await store.submitTask({
      repositoryId: "repo",
      objective,
      agentId: "builder",
      validationCommands: [],
      ...(options.planOnly === true ? { planOnly: true } : {}),
    });
  const statuses = async () =>
    new Map(
      (await store.listSubmittedTasks({ repositoryId: "repo" })).map((task) => [
        task.id,
        task.status,
      ]),
    );
  return { store, workerId: worker.id, submit, statuses };
}

test("pausing running work releases its lease and leaves the row resumable", async () => {
  const { store, workerId, submit, statuses } = await harness();

  const running = await submit("running work");
  const leased = await store.leaseNextTask({
    workerId,
    repositoryId: "repo",
    baseRevision: BASE_REVISION,
    ttlMs: 60_000,
  });
  assert.equal(leased?.task.id, running.id);

  const aborted: Array<{ taskId: string; reason: string }> = [];
  const cancellations = new TaskCancellationRegistry();
  cancellations.register(running.id, async (reason) => {
    aborted.push({ taskId: running.id, reason });
  });

  const reports = await pauseTasks(store, {
    repositoryId: "repo",
    taskIds: [running.id],
    reason: "Paused from the thread",
    actorId: "user-1",
    cancellations,
  });

  assert.deepEqual(
    reports.map((entry) => [entry.id, entry.was]),
    [[running.id, "running"]],
  );
  // The live session was stopped in the pauser's own words, and the registry
  // knows it was a pause — which is what keeps the run's own checkpoint from
  // tearing the workspace down.
  assert.deepEqual(aborted, [
    { taskId: running.id, reason: "Paused from the thread" },
  ]);
  assert.equal(cancellations.intentFor(running.id), "pause");
  assert.equal(cancellations.reasonFor(running.id), "Paused from the thread");

  // Paused, not cancelled: the distinction is the whole feature.
  assert.equal((await statuses()).get(running.id), "paused");

  // The lease goes back either way. A pause that held its lease would make
  // one person's pause into every other agent's wait.
  const leases = await store.listWorkLeases({ repositoryId: "repo" });
  assert.equal(leases[0]?.status, "released");

  const events = await store.listAuditEvents({ types: ["task_paused"] });
  assert.deepEqual(
    events.map((entry) => entry.event.taskId),
    [running.id],
  );
  assert.equal(
    (events[0]?.event.data as Record<string, unknown>)["reason"],
    "Paused from the thread",
  );
});

test("paused work is not leasable, and resuming puts the same task back in the queue", async () => {
  const { store, workerId, submit, statuses } = await harness();
  const task = await submit("queued work");

  await pauseTasks(store, {
    repositoryId: "repo",
    taskIds: [task.id],
    reason: "Paused from the thread",
  });
  assert.equal((await statuses()).get(task.id), "paused");

  // Nothing may pick it up while it is parked — that is what makes pause a
  // stop rather than a label.
  assert.equal(
    await store.leaseNextTask({
      workerId,
      repositoryId: "repo",
      baseRevision: BASE_REVISION,
      ttlMs: 60_000,
    }),
    undefined,
  );

  const resumed = await resumeTasks(store, {
    repositoryId: "repo",
    taskIds: [task.id],
    reason: "Resumed from the thread",
    actorId: "user-1",
  });
  assert.deepEqual(
    resumed.map((entry) => entry.id),
    [task.id],
  );
  assert.equal((await statuses()).get(task.id), "submitted");

  // The same task, not a new one: resuming must not fork the work.
  assert.equal((await store.listSubmittedTasks({ repositoryId: "repo" })).length, 1);
  const relet = await store.leaseNextTask({
    workerId,
    repositoryId: "repo",
    baseRevision: BASE_REVISION,
    ttlMs: 60_000,
  });
  assert.equal(relet?.task.id, task.id);

  const events = await store.listAuditEvents({ types: ["task_resumed"] });
  assert.deepEqual(
    events.map((entry) => entry.event.taskId),
    [task.id],
  );
});

test("a second press of play, and a pause of settled work, do nothing", async () => {
  const { store, submit, statuses } = await harness();
  const task = await submit("work");

  await pauseTasks(store, {
    repositoryId: "repo",
    taskIds: [task.id],
    reason: "Paused",
  });
  assert.equal(
    (
      await resumeTasks(store, {
        repositoryId: "repo",
        taskIds: [task.id],
        reason: "Resumed",
      })
    ).length,
    1,
  );
  // Two resumes racing must produce one queued task, not two runs of it.
  assert.deepEqual(
    await resumeTasks(store, {
      repositoryId: "repo",
      taskIds: [task.id],
      reason: "Resumed again",
    }),
    [],
  );

  // A pause that arrives after the work ended reports nothing rather than
  // dragging a finished task back out of its ending.
  await store.claimSubmittedTasks("repo");
  await store.completeSubmittedTask(task.id, "integrated");
  assert.deepEqual(
    await pauseTasks(store, {
      repositoryId: "repo",
      taskIds: [task.id],
      reason: "Too late",
    }),
    [],
  );
  assert.equal((await statuses()).get(task.id), "integrated");
});

test("a held plan is not pausable, and paused work survives a repository-wide stop", async () => {
  const { store, submit, statuses } = await harness();
  const held = await submit("held plan", { planOnly: true });
  const parked = await submit("parked work");

  // Pausing something already stopped would be offering to do nothing.
  assert.deepEqual(
    await pauseTasks(store, {
      repositoryId: "repo",
      taskIds: [held.id],
      reason: "Paused",
    }),
    [],
  );
  assert.equal((await statuses()).get(held.id), "planned");

  await pauseTasks(store, {
    repositoryId: "repo",
    taskIds: [parked.id],
    reason: "Paused",
  });

  // "Stop what is running" has no business discarding work somebody
  // deliberately parked — the same rule that spares an open conversation.
  await cancelTasks(store, {
    repositoryId: "repo",
    reason: "Stopped from the channel",
  });
  assert.equal((await statuses()).get(parked.id), "paused");

  // Naming it explicitly still ends it: changing your mind about paused work
  // is abandoning it, and there has to be a way to do that.
  const stopped = await cancelTasks(store, {
    repositoryId: "repo",
    taskIds: [parked.id],
    reason: "Abandoned",
  });
  assert.deepEqual(
    stopped.map((entry) => [entry.id, entry.was]),
    [[parked.id, "held"]],
  );
  assert.equal((await statuses()).get(parked.id), "cancelled");
});
