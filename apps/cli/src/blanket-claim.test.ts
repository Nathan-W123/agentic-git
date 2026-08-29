import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import type { CanonicalVersion, TaskDefinition } from "@coord/shared-types";
import { claimCoversPath, isBlanketClaim } from "@coord/shared-types";
import type { AgentPlan } from "@coord/shared-types";
import type { WorkspaceManager } from "@coord/workspace-manager";

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

// Named, with a directory behind it that nothing reads. The tests that stop
// at the blanket refusal never open it; the ones that reach an index build
// pass a real repository instead. Carrying the path anyway keeps every row
// this is written into agreeing with every other.
const REPOSITORY = {
  id: "repo_a",
  path: "/tmp/repo_a",
  branch: "main",
} as CanonicalRepository;

async function seed(
  /**
   * The canonical repository the store should record. Defaults to a name with
   * no directory behind it, which is all the tests that stop at the blanket
   * refusal ever need; the ones that reach an index build pass a real one.
   */
  repository: CanonicalRepository = REPOSITORY,
): Promise<{
  store: InMemoryCoordinationStore;
  worker: string;
}> {
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: repository.id,
    path: repository.path,
    branch: repository.branch,
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
  base: CanonicalVersion = BASE,
): Promise<{ leaseId: string; task: TaskDefinition }> {
  const submitted = await store.submitTask({
    repositoryId: "repo_a",
    objective,
    agentId: "agent-a",
    validationCommands: [],
  });
  const leased = await store.leaseNextTask({
    workerId: worker,
    baseRevision: base.revision,
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
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
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
      // No estimate: the claim covers the repository and an arrival behind
      // it is refused, which is the shape these tests were written for.
      estimatedFiles: [],
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
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
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
    estimatedFiles: [],
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
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
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
      // No estimate: the claim covers the repository and an arrival behind
      // it is refused, which is the shape these tests were written for.
      estimatedFiles: [],
      baseVersion: BASE,
    }),
    undefined,
  );
});

test("a holder with nothing to narrow to at all keeps the whole repository", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
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
    estimatedFiles: [],
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
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
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

test("a holder that has written nothing is narrowed to its estimate", async () => {
  const { store, worker } = await seed();
  const first = await leaseFor(store, worker, "rewrite the renderer");
  const holder = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await holder.claimRepository({
    task: first.task,
    repository: REPOSITORY,
    // No estimate: the claim covers the repository and an arrival behind
    // it is refused, which is the shape these tests were written for.
    estimatedFiles: [],
    baseVersion: BASE,
  });
  assert.notEqual(claim, undefined);
  await leaseFor(store, worker, "fix the audio mixer");

  // The same window as the test above — the arrival lands before the holder's
  // first write — but this claim was granted against an anchored estimate, so
  // there is something to narrow to that is not an observation.
  const frozen = await holder.freezeBlanketClaim({
    task: first.task,
    plan: claim!,
    planRevision: 1,
    repository: REPOSITORY,
    baseVersion: BASE,
    estimatedFiles: ["src/renderer/draw.ts", "src/renderer/shade.ts"],
    observe: async () => [],
  });

  assert.notEqual(
    frozen,
    undefined,
    "an anchored estimate is something to narrow to, so the freeze must land",
  );
  assert.deepEqual(frozen?.expectedFiles, [
    "src/renderer/draw.ts",
    "src/renderer/shade.ts",
  ]);
  assert.equal(frozen?.claim?.kind, "frozen");

  const lease = await store.getWorkLease(first.leaseId);
  assert.ok(
    lease?.plan !== undefined && !isBlanketClaim(lease.plan.plan),
    "the durable claim is no longer repository-wide",
  );

  // And the point of all of it: the file the arriving task wants is no longer
  // inside what the holder claims. Whether admission then says yes is covered
  // against a real repository in partial-admission-crossrun.test.ts; what
  // matters here is that the holder stopped standing in the way of it while
  // it had not started typing.
  assert.equal(
    claimCoversPath(frozen!, "src/audio/mixer.ts"),
    false,
    "the narrowed claim should no longer reach the arriving task's file",
  );
  assert.equal(
    claimCoversPath(frozen!, "src/renderer/draw.ts"),
    true,
    "and should still reach its own",
  );
});

/**
 * The arrival-driven narrowing, which is the half a holder cannot do for
 * itself.
 *
 * A blanket holder narrows its own claim on a timer, from a live workspace
 * handle. The task that turns up behind it has neither — the holder is another
 * process — so this path rebuilds the holder's worktree from the row recorded
 * when its task started, and reads it. What it must never do is narrow from
 * the claim's own lexical estimate, which is what it did: a guess about a task
 * that never planned, and one that leaves every modified-but-unguessed file
 * free for the arrival to take.
 */
/**
 * A canonical repository with real files in it.
 *
 * The tests above stop at the blanket refusal and never need one. These go
 * further — past the narrowing and into admission, which builds a repository
 * index — so a stub with no path on disk fails inside `git ls-tree` rather
 * than telling us anything about arbitration.
 */
async function realRepository(): Promise<{
  repository: CanonicalRepository;
  version: CanonicalVersion;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-blanket-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  await mkdir(path.join(source, "src"), { recursive: true });
  for (const name of ["a", "b", "c"]) {
    await writeFile(
      path.join(source, "src", `${name}.ts`),
      `export function ${name}(): number {\n  return 1;\n}\n`,
      "utf8",
    );
  }
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    path.join(root, "canonical.git"),
    "repo_a",
  );
  return {
    repository,
    // The revision the index will actually be built against. `BASE` is a
    // fabricated forty-character string, which is all a test that never
    // touches git needs and is a tree that does not exist to one that does.
    version: await repositories.getCanonicalVersion(repository),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function stubWorkspaces(
  changes:
    | Array<{ path: string; status: "modified" | "added" }>
    | (() => never),
): WorkspaceManager {
  return {
    listWorkingChanges: async () =>
      typeof changes === "function" ? changes() : changes,
  } as unknown as WorkspaceManager;
}

function arrivingPlan(taskId: string, files: string[]): AgentPlan {
  return {
    taskId,
    objective: "work elsewhere",
    intent: "work elsewhere",
    expectedFiles: files,
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

async function holderWithWorktree(
  store: InMemoryCoordinationStore,
  worker: string,
  estimatedFiles: string[],
  repository: CanonicalRepository = REPOSITORY,
  base: CanonicalVersion = BASE,
): Promise<{ leaseId: string; task: TaskDefinition }> {
  const first = await leaseFor(store, worker, "rewrite the renderer", base);
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await authority.claimRepository({
    task: first.task,
    repository,
    estimatedFiles,
    baseVersion: base,
  });
  assert.notEqual(claim, undefined, "the holder should hold the repository");
  // The row the arrival crosses processes on. Written at task start in the
  // real coordinator, before any execution.
  const run = await store.createRun({
    repository,
    mode: "coordinated",
    baseVersion: base,
  });
  await store.saveWorkspace(run.id, {
    id: "ws_holder",
    runId: run.id,
    taskId: first.task.id,
    path: "/tmp/repo_a-holder",
    isolation: "git-worktree",
    baseRevision: base.revision,
    createdAt: base.createdAt,
  });
  return first;
}

test("an arrival narrows the holder to the worktree, not to its guess", async () => {
  const real = await realRepository();
  const { store, worker } = await seed(real.repository);
  try {
  // The estimate named one file; the holder is actually editing another.
  const first = await holderWithWorktree(
    store,
    worker,
    ["src/a.ts"],
    real.repository,
    real.version,
  );
  const second = await leaseFor(
    store,
    worker,
    "fix the audio mixer",
    real.version,
  );

  const arriving = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
    workspaces: stubWorkspaces([
      { path: "src/b.ts", status: "modified" },
    ]),
  });
  const decision = await arriving.admit({
    task: second.task,
    plan: arrivingPlan(second.task.id, ["src/b.ts", "src/c.ts"]),
    planRevision: 1,
    baseVersion: real.version,
    repository: real.repository,
  });

  // The file the holder is provably inside is not handed over, even though
  // the holder never named it. That was the hole: for a frozen claim
  // `claimOccupiesPath` reads `expectedFiles` alone, so a modified-but-
  // unestimated path was simply free.
  const granted =
    decision.outcome === "admitted"
      ? decision.plan.expectedFiles
      : [];
  assert.ok(
    !granted.includes("src/b.ts"),
    `the holder's open file was granted away: ${JSON.stringify(decision)}`,
  );

  // And the holder's lease now records both — the guess and the observation,
  // unioned rather than substituted, so nothing it could already reach is
  // taken away from it.
  const lease = await store.getWorkLease(first.leaseId);
  const held = lease?.plan?.plan.expectedFiles ?? [];
  assert.ok(held.includes("src/a.ts"), JSON.stringify(held));
  assert.ok(held.includes("src/b.ts"), JSON.stringify(held));
  } finally {
    await real.cleanup();
  }
});

test("a claim frozen on arrival holds its files whole", async () => {
  const real = await realRepository();
  const { store, worker } = await seed(real.repository);
  const first = await holderWithWorktree(
    store,
    worker,
    ["src/a.ts"],
    real.repository,
    real.version,
  );
  await leaseFor(store, worker, "fix the audio mixer", real.version);
  const second = await leaseFor(
    store,
    worker,
    "and another thing",
    real.version,
  );

  const arriving = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
    workspaces: stubWorkspaces([
      { path: "src/b.ts", status: "modified" },
    ]),
  });
  await arriving.admit({
    task: second.task,
    plan: arrivingPlan(second.task.id, ["src/c.ts"]),
    planRevision: 1,
    baseVersion: real.version,
    repository: real.repository,
  });
  await real.cleanup();

  // No line ranges reach the freeze from here, whatever a workspace manager
  // learns to report later. A claim nobody planned is held whole: the lines
  // its holder has written bound where it has been, never where it is going.
  const lease = await store.getWorkLease(first.leaseId);
  const claim = lease?.plan?.plan.claim;
  assert.equal(claim?.kind, "frozen");
  assert.equal(
    (claim as { touched?: unknown } | undefined)?.touched,
    undefined,
  );
});

test("a holder whose edits cannot be read keeps the whole repository", async () => {
  for (const [label, workspaces, seedWorkspace] of [
    [
      "the read throws",
      stubWorkspaces(() => {
        throw new Error("index.lock is held");
      }),
      true,
    ],
    ["no workspace was recorded", stubWorkspaces([]), false],
  ] as const) {
    const { store, worker } = await seed();
    const first = seedWorkspace
      ? await holderWithWorktree(store, worker, ["src/a.ts"])
      : await (async () => {
          const held = await leaseFor(store, worker, "rewrite the renderer");
          const authority = new LeasePlanAuthority({
            store,
            leaseIdForTask: new Map([[held.task.id, held.leaseId]]),
          });
          assert.notEqual(
            await authority.claimRepository({
              task: held.task,
              repository: REPOSITORY,
              estimatedFiles: ["src/a.ts"],
              baseVersion: BASE,
            }),
            undefined,
          );
          return held;
        })();
    const second = await leaseFor(store, worker, "fix the audio mixer");

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces,
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: arrivingPlan(second.task.id, ["src/b.ts"]),
      planRevision: 1,
      baseVersion: BASE,
      repository: REPOSITORY,
    });

    // Not narrowed at all. Every catch on this path would otherwise read as
    // "the holder has written nothing", which is the hole reopened by an
    // unrelated git failure — so a read that cannot be trusted declines, and
    // the arrival waits instead.
    assert.notEqual(decision.outcome, "admitted", `${label}: ${JSON.stringify(decision)}`);
    const lease = await store.getWorkLease(first.leaseId);
    assert.ok(
      isBlanketClaim(lease!.plan!.plan),
      `${label}: the claim should still cover the repository`,
    );
    // Read off `entry.event`, which is where `listAuditEvents` puts the audit
    // record. This read the wrapper instead, so the filter matched nothing
    // whatever happened and the assertion below could not fail.
    const narrowings = (
      await store.listAuditEvents({ types: ["blanket_claim_frozen"] })
    ).filter((entry) => entry.event.data["narrowedOnArrival"] === true);
    assert.deepEqual(narrowings, [], label);
  }
});

test("a file the holder guessed at and never entered goes to whoever asks for it", async () => {
  const real = await realRepository();
  const { store, worker } = await seed(real.repository);
  try {
    // The holder's objective anchored three files. It is in exactly one of
    // them — roughly the ratio a blanket claim runs at in this repository,
    // where nine of every ten estimated files are never opened.
    const first = await holderWithWorktree(
      store,
      worker,
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      real.repository,
      real.version,
    );
    const second = await leaseFor(
      store,
      worker,
      "fix the audio mixer",
      real.version,
    );

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([{ path: "src/a.ts", status: "modified" }]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: arrivingPlan(second.task.id, ["src/b.ts"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    // The whole point: the arrival runs now rather than waiting out
    // `maxWaitMs` for a file the holder was never going to open.
    assert.equal(decision.outcome, "admitted", JSON.stringify(decision));

    const frozen = (await store.getWorkLease(first.leaseId))!.plan!.plan;
    assert.equal(frozen.claim?.kind, "frozen");
    assert.ok(
      frozen.expectedFiles.includes("src/a.ts"),
      `the holder keeps the file it is editing: ${frozen.expectedFiles.join(", ")}`,
    );
    // A guess nobody asked for is not taken off the holder. Releasing on
    // idleness alone would give away ground and gain nobody anything.
    assert.ok(
      frozen.expectedFiles.includes("src/c.ts"),
      `an uncontested guess should be kept: ${frozen.expectedFiles.join(", ")}`,
    );
    assert.ok(
      !frozen.expectedFiles.includes("src/b.ts"),
      `the contested guess should have been released: ${frozen.expectedFiles.join(", ")}`,
    );

    const [narrowing] = (
      await store.listAuditEvents({ types: ["blanket_claim_frozen"] })
    ).filter((entry) => entry.event.data["narrowedOnArrival"] === true);
    assert.deepEqual(
      narrowing?.event.data["releasedFiles"],
      ["src/b.ts"],
      "what was handed over has to be on the record",
    );
  } finally {
    await real.cleanup();
  }
});

test("nothing is released by a holder that has written nothing yet", async () => {
  const real = await realRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const first = await holderWithWorktree(
      store,
      worker,
      ["src/a.ts", "src/b.ts"],
      real.repository,
      real.version,
    );
    const second = await leaseFor(
      store,
      worker,
      "fix the audio mixer",
      real.version,
    );

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      // Readable, and empty: the holder has started but produced nothing.
      workspaces: stubWorkspaces([]),
    });
    await arriving.admit({
      task: second.task,
      plan: arrivingPlan(second.task.id, ["src/b.ts"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    // Presence is evidence of presence and never of absence. A holder that
    // has written nothing has said nothing about where it is *not* going,
    // and its estimate is the only statement it has made — so it keeps it.
    const frozen = (await store.getWorkLease(first.leaseId))!.plan!.plan;
    assert.ok(
      frozen.expectedFiles.includes("src/b.ts"),
      `a holder with no observed edits keeps its estimate: ${frozen.expectedFiles.join(", ")}`,
    );
  } finally {
    await real.cleanup();
  }
});

/**
 * The case backlog item #14 says was never covered: a holder that really is a
 * blanket claim.
 *
 * Every partial-admission test in the repository constructs a holder with no
 * claim at all, which a solo-started agent never is. A real one is handed the
 * whole repository without being asked to describe itself, so it carries
 * `expectedSymbols: []` and a claim — and each of those independently stops
 * the arrival being split into its files. Freezing does not fix either: it
 * never adds symbols and it keeps a claim. So partial admission could never
 * fire between the first and second task in a repository, which is the order
 * people actually work in.
 *
 * What follows drives the whole sequence against the real store and a real
 * index: solo claim, second arrival, the holder asked and answering, and the
 * arrival admitted *into the same file*.
 */

/** One file with four functions in it, which is what makes sharing possible. */
async function sharedRepository(): Promise<{
  repository: CanonicalRepository;
  version: CanonicalVersion;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-declared-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "src", "shared.ts"),
    [
      "export function holderOne(): number {",
      "  return 1;",
      "}",
      "",
      "export function holderTwo(): number {",
      "  return 2;",
      "}",
      "",
      "export function candidateOne(): number {",
      "  return 3;",
      "}",
      "",
      "export function candidateTwo(): number {",
      "  return 4;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(source, "src", "quiet.ts"),
    "export function quiet(): number {\n  return 0;\n}\n",
    "utf8",
  );
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    path.join(root, "canonical.git"),
    "repo_a",
  );
  return {
    repository,
    version: await repositories.getCanonicalVersion(repository),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A holder alone in the repository, holding all of it, with no estimate. */
async function soloHolder(
  store: InMemoryCoordinationStore,
  worker: string,
  repository: CanonicalRepository,
  version: CanonicalVersion,
): Promise<{
  leaseId: string;
  task: TaskDefinition;
  authority: LeasePlanAuthority;
  claim: AgentPlan;
}> {
  const first = await leaseFor(store, worker, "rewrite the renderer", version);
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[first.task.id, first.leaseId]]),
  });
  const claim = await authority.claimRepository({
    task: first.task,
    repository,
    estimatedFiles: [],
    baseVersion: version,
  });
  assert.notEqual(claim, undefined, "the holder should hold the repository");
  assert.ok(isBlanketClaim(claim!));
  return { ...first, authority, claim: claim! };
}

function candidatePlan(
  taskId: string,
  files: string[],
  symbols: string[],
): AgentPlan {
  return {
    taskId,
    objective: "add a currency prefix where a candidate value is shown",
    intent: "add a currency prefix",
    expectedFiles: files,
    expectedSymbols: symbols,
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

/** Whether two inclusive line ranges share a line. */
function intersects(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

test("a task arriving behind a blanket claim is admitted into the holder's own file", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const holder = await soloHolder(store, worker, real.repository, real.version);
    const second = await leaseFor(
      store,
      worker,
      "add a currency prefix",
      real.version,
    );

    // The ask. A real holder is paused, asked this, and resumed; here the
    // adapter round trip is the closure the coordinator supplies, exactly as
    // `observe` is.
    let asked = 0;
    const frozen = await holder.authority.freezeBlanketClaim({
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: [],
      observe: async () => [],
      declare: async () => {
        asked += 1;
        return {
          files: ["src/shared.ts"],
          symbols: ["holderOne", "holderTwo"],
        };
      },
    });

    assert.equal(asked, 1, "the holder is asked exactly once");
    assert.notEqual(frozen, undefined, "the claim should have been converted");
    assert.equal(
      frozen?.claim?.kind,
      "declared",
      `a converted holder must not keep a frozen claim: ${JSON.stringify(frozen?.claim)}`,
    );
    // The two things freezing could never produce, and without both of which
    // the arrival cannot be split into this file.
    assert.deepEqual(frozen?.expectedSymbols, ["holderOne", "holderTwo"]);
    assert.deepEqual(frozen?.declared?.symbols, ["holderOne", "holderTwo"]);
    assert.deepEqual(
      frozen?.claim?.kind === "declared" ? frozen.claim.held : ["unset"],
      [],
      "nothing was touched-and-unmentioned, so nothing is held whole",
    );

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    assert.equal(
      decision.outcome,
      "admitted",
      `the arrival should have been admitted: ${JSON.stringify(decision)}`,
    );
    if (decision.outcome !== "admitted") {
      return;
    }
    assert.deepEqual(
      decision.plan.expectedFiles,
      ["src/shared.ts"],
      "the arrival is granted the holder's own file, not a different one",
    );
    const admission = decision.admission;
    assert.notEqual(
      admission,
      undefined,
      "a whole-file grant would mean the holder was not narrowed at all",
    );
    assert.equal(admission?.status, "approved_with_constraints");

    // What was refused: the functions the holder named, and only those.
    const withheld = (admission?.deferredResources ?? []).flatMap(
      (resource) => resource.locations ?? [],
    );
    assert.ok(withheld.length > 0, JSON.stringify(admission?.deferredResources));
    assert.ok(
      (admission?.deferredResources ?? []).some(
        (resource) => resource.resourceId === "holderOne",
      ),
      `the holder's declarations should be the withheld half: ${JSON.stringify(admission?.deferredResources)}`,
    );

    // What was granted: a lease on the same file, carrying the complement.
    const granted = (admission?.ownershipGrants ?? []).find(
      (lease) =>
        lease.resourceType === "file" && lease.resourceId === "src/shared.ts",
    );
    assert.notEqual(granted, undefined, "no file lease was granted");
    assert.notEqual(
      granted?.ranges,
      undefined,
      "a lease with no ranges is the whole file, which is not a split",
    );
    // The assertion the whole change exists for: the two halves do not touch.
    for (const held of withheld) {
      for (const range of granted?.ranges ?? []) {
        assert.equal(
          intersects(held, range),
          false,
          `granted ${JSON.stringify(range)} overlaps withheld ${JSON.stringify(held)}`,
        );
      }
    }

    const declared = await store.listAuditEvents({
      types: ["blanket_claim_declared"],
    });
    assert.equal(declared.length, 1, "the conversion is on the record");
  } finally {
    await real.cleanup();
  }
});

test("a file the holder has written in but did not mention stays whole to it", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const holder = await soloHolder(store, worker, real.repository, real.version);
    await leaseFor(store, worker, "touch the quiet file", real.version);
    const second = await leaseFor(store, worker, "and again", real.version);

    const frozen = await holder.authority.freezeBlanketClaim({
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: [],
      // Already writing in quiet.ts, and about to forget to say so.
      observe: async () => [
        { path: "src/quiet.ts", status: "modified" as const },
      ],
      declare: async () => ({
        files: ["src/shared.ts"],
        symbols: ["holderOne"],
      }),
    });

    // The footprint is the union, never the answer alone. A holder whose
    // written work was handed to somebody else would have it overwritten in
    // silence, and neither side would notice.
    assert.ok(
      frozen?.expectedFiles.includes("src/quiet.ts"),
      `the observed file was dropped: ${JSON.stringify(frozen?.expectedFiles)}`,
    );
    assert.deepEqual(
      frozen?.claim?.kind === "declared" ? frozen.claim.held : [],
      ["src/quiet.ts"],
      "touched and unmentioned must be held whole, not shared around symbols",
    );

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/quiet.ts"], ["quiet"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });
    const granted =
      decision.outcome === "admitted" ? decision.plan.expectedFiles : [];
    assert.ok(
      !granted.includes("src/quiet.ts"),
      `a file the holder is already writing in was granted away: ${JSON.stringify(decision)}`,
    );
  } finally {
    await real.cleanup();
  }
});

test("a file the holder has not touched yet is still its own once it names it", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const holder = await soloHolder(store, worker, real.repository, real.version);
    const second = await leaseFor(store, worker, "work on quiet", real.version);

    const frozen = await holder.authority.freezeBlanketClaim({
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: [],
      // Nothing written anywhere: this holder is still reading.
      observe: async () => [],
      declare: async () => ({
        files: ["src/quiet.ts"],
        symbols: ["quiet"],
      }),
    });
    assert.deepEqual(frozen?.expectedFiles, ["src/quiet.ts"]);

    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/quiet.ts"], ["quiet"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });
    // `quiet` is the only declaration in the file and the holder named it, so
    // there is nothing left to grant — a forecast is a claim exactly as a
    // written line is, which is the contract every planned agent runs under.
    const granted =
      decision.outcome === "admitted" ? decision.plan.expectedFiles : [];
    assert.ok(
      !granted.includes("src/quiet.ts"),
      `a file the holder declared was granted away: ${JSON.stringify(decision)}`,
    );
  } finally {
    await real.cleanup();
  }
});

test("a holder that does not answer falls back to today's freeze", async () => {
  for (const [label, answer] of [
    ["no answer", async () => undefined],
    ["throws", async () => { throw new Error("the CLI died"); }],
    ["empty", async () => ({ files: [], symbols: [] })],
    ["files but no symbols", async () => ({ files: ["src/shared.ts"], symbols: [] })],
    ["symbols but no files", async () => ({ files: [], symbols: ["holderOne"] })],
    ["junk paths", async () => ({ files: ["/etc/passwd", "../escape.ts"], symbols: ["x"] })],
  ] as Array<[string, () => Promise<{ files: string[]; symbols: string[] } | undefined>]>) {
    const real = await sharedRepository();
    const { store, worker } = await seed(real.repository);
    try {
      const holder = await soloHolder(
        store,
        worker,
        real.repository,
        real.version,
      );
      const second = await leaseFor(store, worker, "arrive", real.version);

      const frozen = await holder.authority.freezeBlanketClaim({
        task: holder.task,
        plan: holder.claim,
        planRevision: 1,
        repository: real.repository,
        baseVersion: real.version,
        estimatedFiles: [],
        observe: async () => [
          { path: "src/shared.ts", status: "modified" as const },
        ],
        declare: answer,
      });

      // Degrade to a wait, never to a wrong grant: exactly the freeze that
      // shipped, on the observed writes alone.
      assert.equal(frozen?.claim?.kind, "frozen", label);
      assert.deepEqual(frozen?.expectedSymbols, [], label);
      assert.deepEqual(
        await store.listAuditEvents({ types: ["blanket_claim_declared"] }),
        [],
        label,
      );

      const arriving = new LeasePlanAuthority({
        store,
        leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      });
      const decision = await arriving.admit({
        task: second.task,
        plan: candidatePlan(
          second.task.id,
          ["src/shared.ts"],
          ["candidateOne"],
        ),
        planRevision: 1,
        baseVersion: real.version,
        repository: real.repository,
      });
      assert.notEqual(
        decision.outcome,
        "admitted",
        `${label}: the arrival must wait exactly as it does today`,
      );
    } finally {
      await real.cleanup();
    }
  }
});

test("an adapter that cannot be asked is never asked", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const holder = await soloHolder(store, worker, real.repository, real.version);
    await leaseFor(store, worker, "arrive", real.version);

    // No `declare` at all — the worker path, or an adapter without
    // pause/requestReplan. The field is optional and absent means today.
    const frozen = await holder.authority.freezeBlanketClaim({
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: [],
      observe: async () => [
        { path: "src/shared.ts", status: "modified" as const },
      ],
    });
    assert.equal(frozen?.claim?.kind, "frozen");
    assert.deepEqual(
      await store.listAuditEvents({ types: ["blanket_claim_declared"] }),
      [],
    );
  } finally {
    await real.cleanup();
  }
});

test("three tasks arriving behind one holder ask it once, not three times", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const holder = await soloHolder(store, worker, real.repository, real.version);
    for (const objective of ["first arrival", "second arrival", "third"]) {
      await leaseFor(store, worker, objective, real.version);
    }

    let asked = 0;
    const request = {
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: [],
      observe: async () => [],
      declare: async () => {
        asked += 1;
        return { files: ["src/shared.ts"], symbols: ["holderOne"] };
      },
    };
    // The holder's own poll, ticking while three tasks queue behind it.
    await holder.authority.freezeBlanketClaim(request);
    await holder.authority.freezeBlanketClaim(request);
    await holder.authority.freezeBlanketClaim(request);

    // One ask per holder per contention episode. Pausing a working agent three
    // times because three people started tasks is not a cost this can carry.
    assert.equal(asked, 1, `the holder was paused ${String(asked)} times`);
  } finally {
    await real.cleanup();
  }
});
