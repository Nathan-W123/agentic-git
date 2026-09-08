/**
 * Does a plan get arbitrated against a branch nobody is currently working on?
 *
 * That is the whole question. The coordinator has always arbitrated against
 * *live leases*, which is right for two agents running at once and blind to
 * the pair that actually collides: two tasks an hour apart, on two branches,
 * that never overlap in time and so never appear in each other's set. The
 * first branch merges, the second tries to catch up, and git reports a
 * collision the coordinator had every piece of information needed to prevent.
 *
 * These drive the real `LeasePlanAuthority` against a real store, with **no
 * second lease active** — because that absence is the case. A test that kept
 * a lease open would pass on the machinery that already worked.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";

import {
  DEFAULT_PROJECT_ID,
  InMemoryCoordinationStore,
} from "@coord/persistence";
import type { AgentPlan } from "@coord/shared-types";

import { LeasePlanAuthority } from "./lease-admission.js";

/**
 * A real canonical repository on disk.
 *
 * Not a path literal: once a branch claim is in the active set, admission
 * stops short-circuiting and goes on to index the repository — which is
 * itself evidence the wiring works, and which needs somewhere real to read
 * from. The two tests that reach it were failing on `not a git repository`,
 * which is a much better failure than the silent approval they would have
 * got before this feature existed.
 */
async function canonicalRepository(): Promise<{
  id: string;
  path: string;
  branch: string;
  revision: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "branch-claims-"));
  const source = path.join(root, "src-repo");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "src", "session.ts"),
    "export function issueToken(): string {\n  return \"t\";\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(source, "src", "retry.ts"),
    "export function retry(): number {\n  return 1;\n}\n",
    "utf8",
  );
  await repositories.commitAll(source, "seed");
  const canonical = await repositories.importLocalRepository(
    source,
    path.join(root, "canon.git"),
    "repo_claims",
    "main",
  );
  const version = await repositories.getCanonicalVersion(canonical);
  return { ...canonical, revision: version.revision };
}

async function fixture(options: { blanket?: boolean } = {}) {
  const REPOSITORY = await canonicalRepository();
  const store = new InMemoryCoordinationStore();
  // A real submitter: `submitTask` verifies the user exists, and a fabricated
  // id fails before any of this is exercised.
  const user = await store.createUser({
    email: "owner@example.com",
    displayName: "Owner",
    passwordDigest: "x",
  });
  await store.saveRepository(REPOSITORY);
  await store.linkRepository(DEFAULT_PROJECT_ID, REPOSITORY.id);
  // Leasing checks the worker exists too. Registering a real one keeps the
  // whole path honest rather than reaching around it.
  const worker = await store.registerWorker({
    userId: user.id,
    organizationId: "org_local",
    name: "test-machine",
    adapters: ["claude"],
    version: "1.0.0",
  });
  return { store, options, userId: user.id, workerId: worker.id, REPOSITORY };
}

/** Submits a task and takes a lease on it, on the branch named. */
async function leaseFor(
  store: InMemoryCoordinationStore,
  input: {
    taskId: string;
    branch?: string;
    userId: string;
    workerId: string;
    repository: { id: string; branch: string; revision: string };
  },
): Promise<{ leaseId: string; taskId: string }> {
  // The id is the store's to mint — `submitTask` ignores one that is passed
  // in, so leasing by the id this test invented matched nothing at all.
  const task = await store.submitTask({
    repositoryId: input.repository.id,
    projectId: DEFAULT_PROJECT_ID,
    agentId: "claude",
    objective: "change the session token",
    submittedBy: input.userId,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  } as never);
  // The real lease path: claim and lease are one transaction, so there is no
  // way to fabricate a lease that the admission code would not also see.
  const taskId = (task as { id: string }).id;
  const leased = await store.leaseNextTask({
    workerId: input.workerId,
    baseRevision: input.repository.revision,
    ttlMs: 600_000,
    taskId,
    repositoryId: input.repository.id,
    projectId: DEFAULT_PROJECT_ID,
  });
  assert.ok(leased !== undefined, `no lease for ${taskId}`);
  return { leaseId: (leased as { lease: { id: string } }).lease.id, taskId };
}

function planFor(taskId: string, overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId,
    objective: "change the session token",
    expectedFiles: ["src/session.ts"],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  } as AgentPlan;
}

test("a branch holding a route is arbitrated against, with nothing running", async () => {
  const { store, userId, workerId, REPOSITORY } = await fixture();

  // #payments-v2 landed work an hour ago and has not merged. Its lease is
  // long gone — that is the point.
  await store.recordBranchClaim({
    repositoryId: REPOSITORY.id,
    branch: "kumi/payments-v2",
    taskId: "task_earlier",
    revision: "a".repeat(40),
    apis: ["POST /charges"],
    ranges: [{ file: "src/payments.ts", start: 1, end: 40 }],
  });
  assert.equal(
    (await store.listWorkLeases({ status: "active" })).length,
    0,
    "the premise: nothing is executing",
  );

  const { leaseId, taskId } = await leaseFor(store, {
    taskId: "task_now",
    branch: "kumi/retry-backoff",
    userId,
    workerId,
    repository: REPOSITORY,
  });
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[taskId, leaseId]]),
    // Off, so this test is about the ordinary path rather than the fast one.
    // The fast path has a test of its own below.
    allowBlanketClaims: false,
  } as never);

  const decision = await authority.admit({
    task: {
      id: taskId,
      agentId: "claude",
      // Admission reads the objective — a stub without one throws inside
      // `isDeferredScopeFollowUp` before any of this is exercised.
      objective: "change the session token",
    },
    repository: REPOSITORY,
    baseVersion: { revision: REPOSITORY.revision, sequence: 1 },
    // The same route the other branch is holding. Nothing textual collides —
    // different files entirely — which is exactly why only the semantic tier
    // can catch it.
    plan: planFor(taskId, {
      expectedFiles: ["src/retry.ts"],
      expectedApis: ["POST /charges"],
    }),
    planRevision: 1,
  } as never);

  // Whatever the ladder decides — narrowed, sequenced, blocked — what must
  // not happen is silent approval of the whole plan. Before branch claims
  // that is precisely what happened, every time, because `active` was empty.
  const asJson = JSON.stringify(decision);
  assert.ok(
    !(decision as { outcome?: string }).outcome ||
      (decision as { outcome?: string }).outcome !== "admitted" ||
      !asJson.includes("POST /charges"),
    `the route another branch holds should not be handed over whole: ${asJson}`,
  );
});

test("two branches editing one ordinary file both proceed", async () => {
  const { store, userId, workerId, REPOSITORY } = await fixture();
  await store.recordBranchClaim({
    repositoryId: REPOSITORY.id,
    branch: "kumi/payments-v2",
    taskId: "task_earlier",
    revision: "a".repeat(40),
    // Local only: an unexported helper, in an ordinary source file. Nothing
    // here crosses to another branch, and a branch that queued behind this
    // would be isolation with extra steps — strictly worse than having no
    // branches at all.
    symbols: ["localHelper"],
    ranges: [{ file: "src/retry.ts", start: 1, end: 40 }],
  });

  const { leaseId, taskId } = await leaseFor(store, {
    taskId: "task_now",
    branch: "kumi/retry-backoff",
    userId,
    workerId,
    repository: REPOSITORY,
  });
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[taskId, leaseId]]),
    allowBlanketClaims: false,
  } as never);

  const decision = await authority.admit({
    task: {
      id: taskId,
      agentId: "claude",
      // Admission reads the objective — a stub without one throws inside
      // `isDeferredScopeFollowUp` before any of this is exercised.
      objective: "change the session token",
    },
    repository: REPOSITORY,
    baseVersion: { revision: REPOSITORY.revision, sequence: 1 },
    // The *same file* the other branch is holding. That is the point: if
    // branch claims were taken whole rather than reduced to what crosses,
    // this would collide on the file and be made to wait — and two channels
    // editing one ordinary source file is the ordinary case, not a conflict.
    // With different files the test could not tell the two apart, and did
    // not: it passed against a version that skipped the reduction entirely.
    plan: planFor(taskId, { expectedFiles: ["src/retry.ts"] }),
    planRevision: 1,
  } as never);
  assert.equal(
    (decision as { outcome?: string }).outcome,
    "admitted",
    `an ordinary file two branches share is not contention: ${JSON.stringify(decision)}`,
  );
});

test("a branch does not contend with its own earlier work", async () => {
  const { store, userId, workerId, REPOSITORY } = await fixture();
  // The same branch this task is on. Its earlier work is the same line of
  // work continuing, and git will fast-forward it — treating it as
  // contention would have every channel block itself after its first task.
  await store.recordBranchClaim({
    repositoryId: REPOSITORY.id,
    branch: "kumi/retry-backoff",
    taskId: "task_earlier",
    revision: "a".repeat(40),
    apis: ["POST /charges"],
  });

  const { leaseId, taskId } = await leaseFor(store, {
    taskId: "task_now",
    branch: "kumi/retry-backoff",
    userId,
    workerId,
    repository: REPOSITORY,
  });
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[taskId, leaseId]]),
    allowBlanketClaims: false,
  } as never);

  const decision = await authority.admit({
    task: {
      id: taskId,
      agentId: "claude",
      // Admission reads the objective — a stub without one throws inside
      // `isDeferredScopeFollowUp` before any of this is exercised.
      objective: "change the session token",
    },
    repository: REPOSITORY,
    baseVersion: { revision: REPOSITORY.revision, sequence: 1 },
    plan: planFor(taskId, { expectedApis: ["POST /charges"] }),
    planRevision: 1,
  } as never);
  assert.equal(
    (decision as { outcome?: string }).outcome,
    "admitted",
    `a channel must not block itself: ${JSON.stringify(decision)}`,
  );
});

test("the blanket fast path does not hand over a repository another branch holds", async () => {
  const { store, userId, workerId, REPOSITORY } = await fixture();
  await store.recordBranchClaim({
    repositoryId: REPOSITORY.id,
    branch: "kumi/payments-v2",
    taskId: "task_earlier",
    revision: "a".repeat(40),
    apis: ["POST /charges"],
  });

  const { leaseId, taskId } = await leaseFor(store, {
    taskId: "task_now",
    branch: "kumi/retry-backoff",
    userId,
    workerId,
    repository: REPOSITORY,
  });
  const authority = new LeasePlanAuthority({
    store,
    leaseIdForTask: new Map([[taskId, leaseId]]),
    // On, which is the default and the case that matters: a task alone in the
    // lease table is granted the whole repository without planning at all.
    // "Alone in the lease table" stopped meaning "unopposed" the moment
    // branches could hold things, and this path would have handed over the
    // very thing the claim exists to protect — on the fast route, without a
    // plan, where nobody would look for it.
    allowBlanketClaims: true,
  } as never);

  const granted = await authority.claimRepository?.({
    task: {
      id: taskId,
      agentId: "claude",
      // Admission reads the objective — a stub without one throws inside
      // `isDeferredScopeFollowUp` before any of this is exercised.
      objective: "change the session token",
    },
    repository: REPOSITORY,
    baseVersion: { revision: REPOSITORY.revision, sequence: 1 },
    estimatedFiles: ["src/retry.ts"],
  } as never);
  assert.equal(
    granted,
    undefined,
    "no blanket claim while another branch is holding something",
  );
});
