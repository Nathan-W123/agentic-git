/**
 * Claims across two branches.
 *
 * Stages one and two give each channel a branch and send its work there. On
 * their own that is isolation: agents in different channels stop contending,
 * which is Conductor with a nicer chat on it and strictly worse than having
 * no branches at all. `#billing` changes `SessionToken.userId`, `#login`
 * changes `SessionToken.expiresAt`, neither conflicts in Git, both merge, and
 * the build breaks — or it does not, and the bug ships.
 *
 * So the claim splits into two tiers. What is local to a branch — a private
 * helper, a file's internals, a test — contends only inside that branch, and
 * Git arbitrates the rest. What crosses between them — an exported symbol, a
 * route, a schema, a manifest, a migration — contends across every branch in
 * the repository, on the same admission ladder with a wider scope.
 *
 * Everything here runs against the real store and a real repository, because
 * the mechanism is an argument about what two processes can see of each other
 * and a fake would agree with itself about exactly the thing in question.
 */

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
import type {
  AgentPlan,
  CanonicalVersion,
  TaskDefinition,
} from "@coord/shared-types";

import { LeasePlanAuthority } from "./lease-admission.js";

const BILLING = "kumi/billing";
const LOGIN = "kumi/login";

interface Fixture {
  store: InMemoryCoordinationStore;
  worker: string;
  repository: CanonicalRepository;
  base: CanonicalVersion;
  cleanup: () => Promise<void>;
}

/**
 * A repository with one exported type and one private helper.
 *
 * The whole test turns on the indexer being able to tell those apart, so it
 * is a real checkout with a real index rather than a hand-written one — a
 * fixture that simply asserted `exportedSymbols` would prove the reduction
 * works and nothing about whether the thing feeding it is right.
 */
async function seed(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-branch-claims-"));
  const source = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "src", "session.ts"),
    [
      "export interface SessionToken { id: string }",
      "export function issue(): SessionToken { return { id: \"\" }; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(source, "src", "login.ts"),
    [
      'import { issue } from "./session.js";',
      "function clampWidth(n: number) { return Math.min(n, 80); }",
      "export function render() { return clampWidth(issue().id.length); }",
      "",
    ].join("\n"),
  );
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    canonicalPath,
    "branch-claims",
  );
  const base = await repositories.getCanonicalVersion(repository);

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
  return {
    store,
    worker: worker.id,
    repository,
    base,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One task, leased, on the branch it was commissioned against. */
async function leaseOn(
  fixture: Fixture,
  objective: string,
  branch: string | undefined,
): Promise<{ leaseId: string; task: TaskDefinition }> {
  const submitted = await fixture.store.submitTask({
    repositoryId: fixture.repository.id,
    objective,
    agentId: "agent-a",
    validationCommands: [],
    ...(branch === undefined ? {} : { branch }),
  });
  const leased = await fixture.store.leaseNextTask({
    workerId: fixture.worker,
    baseRevision: fixture.base.revision,
    ttlMs: 60_000,
    taskId: submitted.id,
    repositoryId: fixture.repository.id,
    repositoryParallelism: 8,
  });
  assert.notEqual(leased, undefined, "the task should have been leased");
  assert.equal(
    leased?.lease.branch,
    branch,
    "the lease should carry the task's branch",
  );
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

function planFor(
  taskId: string,
  scope: { files: string[]; symbols: string[] },
): AgentPlan {
  return {
    taskId,
    objective: "change it",
    expectedFiles: scope.files,
    expectedSymbols: scope.symbols,
    // `PlanDeclarations` has no `files`: the file list is never widened by
    // enrichment, so `expectedFiles` is already the agent's own words.
    declared: { symbols: scope.symbols },
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
  };
}

/**
 * What a plan was actually granted, as one flat list of resources.
 *
 * Asserted on rather than on the outcome word, because contention has two
 * shapes and only one of them is a refusal: an overlap the ladder can carve
 * around comes back `admitted` with the contested resource *withheld*, which
 * reads as success and is a denial. A test that checked `outcome` alone would
 * pass for a partial admission that granted nothing and for a full one that
 * granted everything, which is to say it would check nothing.
 *
 * Empty when the decision was a refusal or a deferral: nothing was granted,
 * which is the answer those outcomes give.
 */
async function granted(
  fixture: Fixture,
  held: { leaseId: string; task: TaskDefinition },
  scope: { files: string[]; symbols: string[] },
): Promise<{ outcome: string; files: string[]; symbols: string[] }> {
  const authority = new LeasePlanAuthority({
    store: fixture.store,
    leaseIdForTask: new Map([[held.task.id, held.leaseId]]),
    // Off, so the first task in the repository plans like every other one
    // rather than taking the whole repository without describing it. This
    // file is about what two described plans say to each other.
    blanketClaims: false,
  });
  const decision = await authority.admit({
    task: held.task,
    plan: planFor(held.task.id, scope),
    planRevision: 1,
    baseVersion: fixture.base,
    repository: fixture.repository,
  });
  if (decision.outcome !== "admitted") {
    return { outcome: decision.outcome, files: [], symbols: [] };
  }
  // The agent's own words, not the enriched lists: enrichment fills
  // `expectedSymbols` from the contents of every declared file, so a symbol
  // there may be one nothing claimed. `declared` is what this plan asked for
  // and `reducePlanScope` narrows it alongside everything else.
  return {
    outcome: decision.outcome,
    files: [...decision.plan.expectedFiles],
    symbols: [...(decision.plan.declared?.symbols ?? [])],
  };
}

test("an exported symbol contends across branches; a private one does not", async (t) => {
  const fixture = await seed();
  t.after(fixture.cleanup);

  // #billing takes the exported type.
  const billing = await leaseOn(fixture, "widen the session token", BILLING);
  const first = await granted(fixture, billing, {
    files: ["src/session.ts"],
    symbols: ["SessionToken"],
  });
  assert.deepEqual(first.symbols, ["SessionToken"]);

  // #login wants the same exported type. Different branch, different files,
  // and Git would merge both without a murmur — which is exactly the collision
  // nothing else in this system can see.
  const contending = await leaseOn(fixture, "expire the session token", LOGIN);
  const across = await granted(fixture, contending, {
    files: ["src/login.ts"],
    symbols: ["SessionToken"],
  });
  assert.equal(
    across.symbols.includes("SessionToken"),
    false,
    "an exported symbol held on another branch must not be handed out",
  );

  // And the other direction, against a holder that really does hold it.
  // #billing takes the private helper too — in the same file #login is about
  // to name, so this is a real overlap and not two plans that never met.
  const alsoBilling = await leaseOn(fixture, "tidy the width clamp", BILLING);
  const held = await granted(fixture, alsoBilling, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.deepEqual(held.symbols, ["clampWidth"]);

  // #login asks for exactly what #billing is holding. Nothing about it
  // crosses branches — a function nobody outside its file can name, in a file
  // Git will merge or conflict on its own — so it is granted. This is the
  // benefit of branching, and a tier that contended on everything would take
  // it away.
  const local = await leaseOn(fixture, "rename the width clamp", LOGIN);
  const alone = await granted(fixture, local, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.deepEqual(
    alone.symbols,
    ["clampWidth"],
    "work private to another branch must not queue behind #billing",
  );
  assert.deepEqual(alone.files, ["src/login.ts"]);
});

test("two tasks on one branch still contend on everything", async (t) => {
  const fixture = await seed();
  t.after(fixture.cleanup);

  const first = await leaseOn(fixture, "rename the width clamp", LOGIN);
  const held = await granted(fixture, first, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.deepEqual(held.symbols, ["clampWidth"]);

  // The same private helper, in the same channel. Nothing about branches
  // changes this: a channel is one shared workspace, and two agents editing
  // one function inside it is the collision arbitration exists for.
  const second = await leaseOn(fixture, "inline the width clamp", LOGIN);
  const contending = await granted(fixture, second, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.equal(
    contending.symbols.includes("clampWidth"),
    false,
    "two tasks on one branch must arbitrate as they always have",
  );
});

test("a manifest is shared even when nothing else about the work is", async (t) => {
  const fixture = await seed();
  t.after(fixture.cleanup);

  const billing = await leaseOn(fixture, "add the stripe client", BILLING);
  const first = await granted(fixture, billing, {
    files: ["package.json", "src/session.ts"],
    symbols: [],
  });
  assert.equal(first.files.includes("package.json"), true);

  // Two branches adding a dependency merge cleanly and produce a tree that
  // installs neither version. Git cannot see it; this can.
  const login = await leaseOn(fixture, "add the oauth client", LOGIN);
  const across = await granted(fixture, login, {
    files: ["package.json", "src/login.ts"],
    symbols: [],
  });
  assert.equal(
    across.files.includes("package.json"),
    false,
    "a dependency manifest is a statement about the whole repository",
  );
  // The rest of the work is its own branch's business and is not held with it.
  if (across.outcome === "admitted") {
    assert.deepEqual(across.files, ["src/login.ts"]);
  }
});

test("a task with no branch is on canonical, and canonical is a branch too", async (t) => {
  const fixture = await seed();
  t.after(fixture.cleanup);

  // Submitted from #general, or from anywhere that predates work channels.
  const general = await leaseOn(fixture, "tidy the width clamp", undefined);
  const first = await granted(fixture, general, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.deepEqual(first.symbols, ["clampWidth"]);

  // A second unbranched task contends with it exactly as two tasks always
  // have — "no branch" is a place, not an exemption.
  const alsoGeneral = await leaseOn(fixture, "inline the width clamp", undefined);
  const together = await granted(fixture, alsoGeneral, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.equal(together.symbols.includes("clampWidth"), false);

  // And a work channel's task is not held by canonical's private work.
  const branched = await leaseOn(fixture, "rename the width clamp", LOGIN);
  const across = await granted(fixture, branched, {
    files: ["src/login.ts"],
    symbols: ["clampWidth"],
  });
  assert.deepEqual(across.symbols, ["clampWidth"]);
});
