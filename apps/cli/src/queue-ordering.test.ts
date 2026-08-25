import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";
import type { CoordinationStore, SubmittedTask } from "@coord/persistence";

import { leaseQueuedWork } from "./commands.js";
import { WORK_LEASE_TTL_MS } from "./worker-operations.js";

/**
 * Which queued task a channel dispatch spends its planning round on.
 *
 * Planning is the expensive half of a lease and it happens before the plan
 * authority is ever consulted: the task is leased, a CLI session starts, the
 * repository is seeded, an agent writes a plan — and only then does admission
 * answer "wait for the task that is holding your files". The whole round is
 * thrown away, the task returns to the queue, and on the next dispatch the
 * oldest queued row is picked up first, which is precisely the row that has
 * been failing to admit. That loop is where a deployment's token budget goes.
 *
 * The remote worker path deprioritises those rows in `nextWorkAssignment`, and
 * measured the difference: 74% of planning calls ending in a deferral fell to
 * 29%. A control-plane deployment never reaches that path — every channel
 * dispatch goes through `runPendingTasks`, which leases here — so this pins
 * the same ordering on the path that actually runs.
 */

const REPOSITORY_ID = "repo_queue";

interface Harness {
  store: CoordinationStore;
  workerId: string;
}

async function createHarness(): Promise<Harness> {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: REPOSITORY_ID,
    path: "/tmp/queue-ordering",
    branch: "main",
  });
  const user = await store.createUser({
    email: "queue@example.com",
    displayName: "Queue",
    passwordDigest: "digest",
  });
  const worker = await store.registerWorker({
    userId: user.id,
    name: "worker-queue",
    adapters: ["generic-cli"],
    organizationId: DEFAULT_ORGANIZATION_ID,
    version: "1.0.0",
  });
  return { store, workerId: worker.id };
}

async function submit(
  harness: Harness,
  objective: string,
): Promise<SubmittedTask> {
  return await harness.store.submitTask({
    repositoryId: REPOSITORY_ID,
    projectId: DEFAULT_PROJECT_ID,
    objective,
    agentId: "generic-cli",
    validationCommands: [],
  });
}

/** Records the refusal a real admission would have written. */
async function refuse(
  harness: Harness,
  taskId: string,
  blockedBy: string,
): Promise<void> {
  await harness.store.appendAudit(undefined, {
    type: "plan_admitted",
    taskId,
    data: { status: "blocked", blockedBy: [blockedBy] },
  });
}

async function leaseFor(harness: Harness) {
  return await leaseQueuedWork(harness.store, {
    workerId: harness.workerId,
    repositoryId: REPOSITORY_ID,
    projectId: DEFAULT_PROJECT_ID,
    baseRevision: "rev_1",
  });
}

test("a task known to be blocked is not the one a dispatch plans first", async () => {
  const previous = process.env["COORD_REPOSITORY_PARALLELISM"];
  // Two at a time: the holder takes one slot, leaving exactly one for the
  // dispatch to spend. Which task gets that slot is the entire question.
  process.env["COORD_REPOSITORY_PARALLELISM"] = "2";
  const harness = await createHarness();
  try {
    const holder = await submit(harness, "the task holding the file");
    const held = await harness.store.leaseNextTask({
      workerId: harness.workerId,
      taskId: holder.id,
      repositoryId: REPOSITORY_ID,
      projectId: DEFAULT_PROJECT_ID,
      baseRevision: "rev_1",
      ttlMs: WORK_LEASE_TTL_MS,
      repositoryParallelism: 2,
    });
    assert.notEqual(held, undefined, "the holder should hold a lease");

    // Submitted before the task that can actually run, so first-in-first-out
    // would choose it — which is what made this worth fixing.
    const blocked = await submit(harness, "the task that keeps being refused");
    await refuse(harness, blocked.id, holder.id);
    const ready = await submit(harness, "the task nothing is holding");

    const leased = await leaseFor(harness);
    assert.equal(leased.length, 1, "one slot, one lease");
    assert.equal(
      leased[0]?.task.id,
      ready.id,
      "the planning round goes to work that can proceed",
    );
    assert.notEqual(leased[0]?.task.id, blocked.id);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_REPOSITORY_PARALLELISM"];
    } else {
      process.env["COORD_REPOSITORY_PARALLELISM"] = previous;
    }
    await harness.store.close();
  }
});

test("a refusal whose blocker has finished stops counting", async () => {
  const previous = process.env["COORD_REPOSITORY_PARALLELISM"];
  process.env["COORD_REPOSITORY_PARALLELISM"] = "1";
  const harness = await createHarness();
  try {
    // The failure mode on the other side of the fix: a task sequenced behind
    // something that has since landed is ready now, and treating the old
    // refusal as still true would postpone it forever.
    const holder = await submit(harness, "the task that already finished");
    const held = await harness.store.leaseNextTask({
      workerId: harness.workerId,
      taskId: holder.id,
      repositoryId: REPOSITORY_ID,
      projectId: DEFAULT_PROJECT_ID,
      baseRevision: "rev_1",
      ttlMs: WORK_LEASE_TTL_MS,
      repositoryParallelism: 1,
    });
    assert.notEqual(held, undefined);
    await harness.store.finishWorkLease(
      held?.lease.id ?? "",
      "completed",
      new Date().toISOString(),
      "landed",
    );
    await harness.store.completeSubmittedTask(holder.id, "integrated");
    const blocked = await submit(harness, "the task refused a while ago");
    await refuse(harness, blocked.id, holder.id);

    const leased = await leaseFor(harness);
    assert.equal(leased.length, 1);
    assert.equal(leased[0]?.task.id, blocked.id);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_REPOSITORY_PARALLELISM"];
    } else {
      process.env["COORD_REPOSITORY_PARALLELISM"] = previous;
    }
    await harness.store.close();
  }
});

test("ordering never withholds work: a fully blocked queue still gets leased", async () => {
  const previous = process.env["COORD_REPOSITORY_PARALLELISM"];
  process.env["COORD_REPOSITORY_PARALLELISM"] = "3";
  const harness = await createHarness();
  try {
    // A preference, not an exclusion. If everything queued is waiting on the
    // holder, the dispatch still takes what the repository's cap allows —
    // the same count as before, in a different order. A task cannot be
    // starved by this, only put behind work that can run today.
    const holder = await submit(harness, "the holder");
    await harness.store.leaseNextTask({
      workerId: harness.workerId,
      taskId: holder.id,
      repositoryId: REPOSITORY_ID,
      projectId: DEFAULT_PROJECT_ID,
      baseRevision: "rev_1",
      ttlMs: WORK_LEASE_TTL_MS,
      repositoryParallelism: 3,
    });
    const first = await submit(harness, "blocked one");
    const second = await submit(harness, "blocked two");
    await refuse(harness, first.id, holder.id);
    await refuse(harness, second.id, holder.id);

    const leased = await leaseFor(harness);
    assert.equal(leased.length, 2, "the cap decides how many, not the order");
    assert.deepEqual(
      new Set(leased.map((entry) => entry.task.id)),
      new Set([first.id, second.id]),
    );
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_REPOSITORY_PARALLELISM"];
    } else {
      process.env["COORD_REPOSITORY_PARALLELISM"] = previous;
    }
    await harness.store.close();
  }
});
