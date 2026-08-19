import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import type { CanonicalRepository } from "@coord/repository-service";
import type { CanonicalVersion, TaskDefinition } from "@coord/shared-types";
import { isBlanketClaim } from "@coord/shared-types";

import { LeasePlanAuthority } from "./lease-admission.js";

/**
 * The durable half of the blanket claim: what is written on the lease, when it
 * is narrowed, and what the task arriving behind it is allowed to have.
 *
 * Everything here runs against the real store the control plane uses, because
 * the whole mechanism is an argument about what two processes can see of each
 * other — a fake would agree with itself about exactly the thing in question.
 */

const BASE: CanonicalVersion = {
  sequence: 1,
  revision: "a".repeat(40),
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const REPOSITORY = { id: "repo_a" } as CanonicalRepository;

async function seed(): Promise<{
  store: InMemoryCoordinationStore;
  worker: string;
}> {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo_a",
    path: "/tmp/repo_a",
    branch: "main",
  });
  const owner = await store.createUser({
    email: "nathan@example.com",
    displayName: "Nathan",
    passwordDigest: "x",
  });
  const organization = await store.createOrganization({
    slug: "acme",
    name: "acme",
  });
  const worker = await store.registerWorker({
    userId: owner.id,
    organizationId: organization.id,
    name: "worker-1",
    adapters: ["prompt-cli"],
    version: "1",
  });
  return { store, worker: worker.id };
}

async function leaseFor(
  store: InMemoryCoordinationStore,
  worker: string,
  objective: string,
): Promise<{ leaseId: string; task: TaskDefinition }> {
  const submitted = await store.submitTask({
    repositoryId: "repo_a",
    objective,
    agentId: "agent-a",
    validationCommands: [],
  });
  const leased = await store.leaseNextTask({
    workerId: worker,
    baseRevision: BASE.revision,
    ttlMs: 60_000,
    taskId: submitted.id,
    repositoryId: "repo_a",
    repositoryParallelism: 4,
  });
  assert.notEqual(leased, undefined, "the task should have been leased");
  return {
    leaseId: leased!.lease.id,
    task: {
      id: submitted.id,
      objective: submitted.objective,
      agentId: submitted.agentId,
      validationCommands: [],
    },
  };
}

test("a task alone in its repository is granted all of it, with no plan", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rename the widget");
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });

  const claim = await authority.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    baseVersion: BASE,
  });

  assert.notEqual(claim, undefined);
  assert.ok(isBlanketClaim(claim!));
  // Durable, because that record is the only thing a second process can see.
  const lease = await store.getWorkLease(first.leaseId);
  assert.ok(lease?.plan !== undefined);
  assert.equal(lease?.plan?.admission.status, "approved");
});

test("a second lease in the repository refuses the blanket claim", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rename the widget");
  await leaseFor(store, worker, "something else entirely");
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });

  // Not alone, so the ordinary planning path is what happens — including for
  // a holder whose competitor has not planned yet, which is exactly when
  // taking everything would be most unfair to it.
  assert.equal(
    await authority.claimRepository({
      task: first.task,
      repository: REPOSITORY,
      baseVersion: BASE,
    }),
    undefined,
  );
});

test("a second task freezes the first to what it has touched", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    baseVersion: BASE,
  });
  assert.notEqual(claim, undefined);

  // Somebody arrives.
  await leaseFor(store, worker, "fix the audio mixer");

  // Still alone as far as the worktree read is concerned? No: the freeze is
  // driven by the arrival, and reads the worktree at that moment.
  let reads = 0;
  const frozen = await holder.freezeBlanketClaim({
    task: first.task,
    plan: claim!,
    planRevision: 1,
    repository: REPOSITORY,
    baseVersion: BASE,
    observe: async () => {
      reads += 1;
      return [
        { path: "src/render/canvas.ts", status: "modified" as const },
        { path: "src/render/shader.ts", status: "added" as const },
      ];
    },
  });

  assert.equal(reads, 1, "the worktree is read once, at freeze time");
  assert.notEqual(frozen, undefined);
  assert.ok(!isBlanketClaim(frozen!));
  assert.deepEqual(frozen?.expectedFiles, [
    "src/render/canvas.ts",
    "src/render/shader.ts",
  ]);
  const lease = await store.getWorkLease(first.leaseId);
  assert.deepEqual(lease?.plan?.plan.expectedFiles, [
    "src/render/canvas.ts",
    "src/render/shader.ts",
  ]);

  // What the arriving task may then have is decided by the admission
  // controller against exactly this record; that half is covered where the
  // controller is, in `services/coordinator/src/blanket-claim.test.ts`.
  assert.deepEqual(
    lease?.plan?.plan.claim?.kind === "frozen"
      ? lease.plan.plan.claim.directories
      : [],
    ["src/render/"],
  );
});

test("a blanket holder defers arrivals immediately rather than queueing them", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    baseVersion: BASE,
  });
  const second = await leaseFor(store, worker, "fix the audio mixer");
  const arriving = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
  });

  // The invariant the whole system rests on: an answer comes back — with a
  // retry the caller decides what to do about — rather than a promise that
  // waits on the holder while the arriving task holds a lease of its own.
  let timer: NodeJS.Timeout | undefined;
  const answer = await Promise.race([
    arriving.admit({
      task: second.task,
      plan: {
        taskId: second.task.id,
        objective: second.task.objective,
        expectedFiles: ["src/audio/mixer.ts"],
        expectedSymbols: [],
        dependencies: [],
        commands: [],
        externalAccess: [],
        riskLevel: "low",
      },
      planRevision: 1,
      baseVersion: BASE,
      repository: REPOSITORY,
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("waited"), 2_000);
    }),
  ]);
  clearTimeout(timer);

  assert.notEqual(answer, "waited");
  assert.equal(
    (answer as { outcome: string; blockedBy?: readonly string[] }).outcome,
    "deferred",
  );
  assert.deepEqual(
    (answer as { blockedBy: readonly string[] }).blockedBy,
    [first.task.id],
  );
});

test("a claim already carrying a contract is never widened into a blanket one", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rename the widget");
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  await authority.admit({
    task: first.task,
    plan: {
      taskId: first.task.id,
      objective: first.task.objective,
      expectedFiles: ["src/widget.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    },
    planRevision: 1,
    baseVersion: BASE,
    repository: REPOSITORY,
  });

  assert.equal(
    await authority.claimRepository({
      task: first.task,
      repository: REPOSITORY,
      baseVersion: BASE,
    }),
    undefined,
  );
});

test("a holder that has written nothing keeps the whole repository", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    baseVersion: BASE,
  });
  assert.notEqual(claim, undefined);
  const second = await leaseFor(store, worker, "fix the audio mixer");

  // The arrival is what drives the freeze, and it can land in the window
  // between the agent being handed its claim and the agent's first write —
  // which is most of a real run's opening seconds.
  const frozen = await holder.freezeBlanketClaim({
    task: first.task,
    plan: claim!,
    planRevision: 1,
    repository: REPOSITORY,
    baseVersion: BASE,
    observe: async () => [],
  });

  // "Narrow to what you have touched" has no answer yet. Answering it anyway
  // does not narrow the claim, it erases it: the holder would be left owning
  // no files at all while it is still about to write them.
  assert.equal(
    frozen,
    undefined,
    "a holder with nothing to freeze to must keep the claim it has",
  );
  const lease = await store.getWorkLease(first.leaseId);
  assert.ok(
    lease?.plan !== undefined && isBlanketClaim(lease.plan.plan),
    "the durable claim is still repository-wide",
  );

  // And the point of all of it: the arriving task is still refused, because
  // the files it wants are the files the holder has not written yet.
  const arriving = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
  });
  const answer = await arriving.admit({
    task: second.task,
    plan: {
      taskId: second.task.id,
      objective: second.task.objective,
      expectedFiles: ["src/audio/mixer.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    },
    planRevision: 1,
    baseVersion: BASE,
    repository: REPOSITORY,
  });
  assert.equal(answer.outcome, "deferred");
});

test("a repository-wide hold is announced, and announced once", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    baseVersion: BASE,
  });
  const second = await leaseFor(store, worker, "fix the audio mixer");
  const arriving = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
  });
  const request = {
    task: second.task,
    plan: {
      taskId: second.task.id,
      objective: second.task.objective,
      expectedFiles: ["src/audio/mixer.ts"],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low" as const,
    },
    planRevision: 1,
    baseVersion: BASE,
    repository: REPOSITORY,
  };

  // Deferred on a timer for as long as the holder runs, which in production
  // is minutes of re-deciding the same thing.
  await arriving.admit(request);
  await arriving.admit(request);
  await arriving.admit(request);

  const holds = await store.listAuditEvents({
    taskId: second.task.id,
    types: ["plan_admitted"],
  });
  // Every other refusal in the system leaves a record; this one returned
  // before reaching it, so a repository-wide hold was the single decision
  // that happened silently — the arbitration was working and looked asleep.
  assert.equal(
    holds.length,
    1,
    `the hold is recorded once per decision, not once per retry (got ${holds.length})`,
  );
  assert.equal(holds[0]?.event.data["status"], "sequenced");
  assert.deepEqual(holds[0]?.event.data["blockedBy"], [first.task.id]);
});
