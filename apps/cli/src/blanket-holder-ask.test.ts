import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentSession,
  CoordinatorContext,
  StartTaskInput,
} from "@coord/agent-protocol";
import { Coordinator, registerBlanketHolder } from "@coord/coordinator";
import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  createId,
  isBlanketClaim,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type ReplanRequest,
  type TaskDefinition,
  type TaskId,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import { LeasePlanAuthority } from "./lease-admission.js";
import {
  askToDeliver,
  rememberWorkingChanges,
  releaseRemoteHolder,
  settleDeclaration,
} from "./remote-holders.js";
import {
  WORKER_PROTOCOL_VERSION,
  claimWorkRepository,
} from "./worker-operations.js";

/**
 * The ask, at the timing production actually runs it at.
 *
 * Every other test of this mechanism calls `freezeBlanketClaim` directly, with
 * a `declare` closure handed to it by the test. That proves the freeze can ask
 * and says nothing about whether anything ever does — and in production
 * nothing ever did. An instrumented run: the watch arms, the arrival lands
 * 144ms later, the whole admission decision completes in nine milliseconds
 * against a claim that was frozen without a word to its holder, and the tick
 * that carried the only ask in the system was still 9.9 seconds away.
 *
 * So these drive the two sides against each other the way the deployment does.
 * A real coordinator run holds the repository; a second authority — a
 * different instance, as a second `runPendingTasks` would build — arrives
 * before the first tick can fire; and what is asserted is what the holder was
 * asked and what the arrival was granted.
 */

/** Where the freeze's own timer would have to fire for a tick to be involved. */
const NEVER_TICKS_MS = 600_000;

/** A promise somebody else resolves. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One file with four functions in it, which is what makes sharing possible,
 * and a second nobody contends for.
 */
async function sharedRepository(): Promise<{
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  version: CanonicalVersion;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-holder-ask-"));
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
    root,
    repository,
    repositories,
    version: await repositories.getCanonicalVersion(repository),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function seed(repository: CanonicalRepository): Promise<{
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
  base: CanonicalVersion,
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

/**
 * A holder that is granted the repository, parks in its edit phase, and
 * answers when it is paused and asked.
 *
 * `requestPlan` throws on purpose: a task alone in its repository must be
 * handed a blanket claim rather than asked to describe itself, and a test that
 * quietly planned instead would be testing nothing this file is about.
 */
class HolderAgent implements AgentAdapter {
  public readonly replans: ReplanRequest[] = [];
  public readonly accepted: AgentPlan[] = [];
  public pauses = 0;
  public resumes = 0;
  /** Resolves when the agent is inside its edit phase, claim in hand. */
  public readonly executing = deferred<void>();
  /** The test resolves this to let the edit phase end. */
  public readonly release = deferred<void>();
  private readonly sessions = new Map<
    string,
    { input: StartTaskInput; context?: CoordinatorContext }
  >();

  public constructor(
    private readonly options: {
      agentId: string;
      repository: CanonicalRepository;
      workspaces: WorkspaceManager;
      declaration?: { files: string[]; symbols: string[] };
      /** A `pause` that never returns, which is bug 3 in one line. */
      pauseHangs?: boolean;
    },
  ) {}

  public async getCapabilities(): Promise<AgentCapabilities> {
    return {
      canPlan: true,
      canEditFiles: true,
      canRunCommands: false,
      canUseTools: false,
      supportsStreaming: false,
      supportsPause: true,
    };
  }

  public async startTask(input: StartTaskInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: createId("session"),
      agentId: this.options.agentId,
      taskId: input.task.id,
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, { input });
    return session;
  }

  public async requestPlan(): Promise<AgentPlan> {
    throw new Error(
      "a solo holder must be granted the repository, not asked to plan",
    );
  }

  public async acceptBlanketClaim(
    _sessionId: string,
    plan: AgentPlan,
  ): Promise<void> {
    this.accepted.push(structuredClone(plan));
  }

  public async requestReplan(
    _sessionId: string,
    request: ReplanRequest,
  ): Promise<AgentPlan> {
    this.replans.push(structuredClone(request));
    const declaration = this.options.declaration;
    if (declaration === undefined) {
      throw new Error("this holder has nothing to say");
    }
    return {
      taskId: request.taskId,
      objective: "the rest of the work",
      expectedFiles: [...declaration.files],
      expectedSymbols: [...declaration.symbols],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    };
  }

  public async sendContext(
    sessionId: string,
    context: CoordinatorContext,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    session.context = context;
    // Nothing is written before the arrival lands, which is the production
    // case: the whole span between an agent starting and its first edit.
    this.executing.resolve();
    await this.release.promise;
  }

  public async pause(): Promise<void> {
    this.pauses += 1;
    if (this.options.pauseHangs === true) {
      await new Promise<never>(() => undefined);
    }
  }

  public async resume(): Promise<void> {
    this.resumes += 1;
  }

  public async resolveScopeChange(): Promise<void> {
    return undefined;
  }

  public async cancel(): Promise<void> {
    return undefined;
  }

  public async collectChanges(sessionId: string): Promise<ChangeSet> {
    const session = this.sessions.get(sessionId);
    if (session?.context === undefined) {
      throw new Error("the holder never entered its edit phase");
    }
    const workspace: TaskWorkspace = {
      id: session.context.decision.workspaceId ?? createId("workspace"),
      taskId: session.input.task.id,
      path: session.context.workspacePath,
      rootPath: session.context.workspacePath,
      repository: this.options.repository,
      baseVersion: session.context.canonicalVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };
    return await this.options.workspaces.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "held the repository and answered when asked",
    });
  }

  public async streamEvents(
    _sessionId: string,
    _handler: (event: AgentEvent) => void,
  ): Promise<void> {
    return undefined;
  }
}

/**
 * A holder executing in a real coordinator run, parked in its edit phase with
 * the repository in hand and its watch armed.
 *
 * The objective names two symbols that exist at this revision, which is what
 * makes the estimate anchored and therefore the claim grantable at all.
 */
async function holdingRun(options: {
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  version: CanonicalVersion;
  store: InMemoryCoordinationStore;
  worker: string;
  declaration?: { files: string[]; symbols: string[] };
  pauseHangs?: boolean;
  pollMs?: number;
  pauseTimeoutMs?: number;
}): Promise<{
  agent: HolderAgent;
  task: TaskDefinition;
  leaseId: string;
  finished: Promise<unknown>;
  workspaces: GitWorktreeWorkspaceManager;
}> {
  const workspaces = new GitWorktreeWorkspaceManager(
    options.repositories.getGitClient(),
  );
  const holder = await leaseFor(
    options.store,
    options.worker,
    "rewrite holderOne and holderTwo in shared.ts",
    options.version,
  );
  const agent = new HolderAgent({
    agentId: "agent-a",
    repository: options.repository,
    workspaces,
    ...(options.declaration === undefined
      ? {}
      : { declaration: options.declaration }),
    ...(options.pauseHangs === undefined
      ? {}
      : { pauseHangs: options.pauseHangs }),
  });
  const coordinator = new Coordinator({
    repositories: options.repositories,
    workspaces,
    store: options.store,
    planAuthority: new LeasePlanAuthority({
      store: options.store,
      leaseIdForTask: new Map([[holder.task.id, holder.leaseId]]),
      workspaces,
    }),
    // Far enough away that no tick can be involved in anything below. The
    // production gap was ten seconds and the arrival decided in nine
    // milliseconds; this only makes the same race unambiguous.
    workingChangePollMs: options.pollMs ?? NEVER_TICKS_MS,
    ...(options.pauseTimeoutMs === undefined
      ? {}
      : { blanketPauseTimeoutMs: options.pauseTimeoutMs }),
  });
  const finished = coordinator
    .run({
      repository: options.repository,
      workspaceRoot: path.join(options.root, "workspaces"),
      integrationRoot: path.join(options.root, "integration"),
      tasks: [{ task: holder.task, adapter: agent }],
    })
    .catch((error: unknown) => error);
  // Either the holder reaches its edit phase or the run ended early, which is
  // a failure worth reading rather than a hang.
  await Promise.race([
    agent.executing.promise,
    finished.then((result) => {
      throw new Error(
        `the holder never reached execution: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  return { agent, task: holder.task, leaseId: holder.leaseId, finished, workspaces };
}

function candidatePlan(
  taskId: TaskId,
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

/**
 * Lets a run finish, and answers whether it did inside the bound.
 *
 * Bounded even in a cleanup path: the failure this file is about is a run that
 * cannot tear down, and a test that waits for one forever reports a hang where
 * it should report a fault.
 */
async function settle(
  finished: Promise<unknown>,
  budgetMs = 20_000,
): Promise<"finished" | "hung"> {
  return await Promise.race([
    finished.then(() => "finished" as const),
    new Promise<"hung">((resolve) => {
      const timer = setTimeout(() => resolve("hung"), budgetMs);
      timer.unref?.();
    }),
  ]);
}

/** Whether two inclusive line ranges share a line. */
function intersects(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

test("an arrival that beats the holder's first tick still asks it", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: { files: ["src/shared.ts"], symbols: ["holderOne", "holderTwo"] },
  });
  try {
    // Nothing written yet — the exact production case, and the one the
    // arrival path could never do anything useful with on its own: a freeze
    // on no observed writes carries no symbols, so the arrival could only
    // ever be sequenced behind it.
    const second = await leaseFor(store, worker, "add a currency prefix", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: held.workspaces,
    });

    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    // The ask fired, from the arrival, with no tick anywhere near it.
    assert.equal(
      held.agent.replans.length,
      1,
      "the holder was never asked what the rest of its work needs",
    );
    assert.equal(held.agent.pauses, 1);
    assert.equal(held.agent.resumes, 1, "a holder asked must be resumed");
    assert.ok(
      held.agent.replans[0]?.constraints?.[0]?.includes(
        "Another task has started in this repository",
      ),
      `the holder was asked something else: ${JSON.stringify(held.agent.replans[0]?.constraints)}`,
    );

    // Partially admitted, not sequenced. This is the difference the whole
    // mechanism exists for, and the log said "sequenced".
    assert.equal(
      decision.outcome,
      "admitted",
      `the arrival should have been admitted: ${JSON.stringify(decision)}`,
    );
    if (decision.outcome !== "admitted") {
      return;
    }
    assert.deepEqual(decision.plan.expectedFiles, ["src/shared.ts"]);
    const admission = decision.admission;
    assert.notEqual(
      admission,
      undefined,
      "a whole-file grant would mean the holder was never narrowed",
    );
    assert.equal(admission?.status, "approved_with_constraints");

    // The holder's declared footprint, and the arrival's grant, do not touch.
    const withheld = (admission?.deferredResources ?? []).flatMap(
      (resource) => resource.locations ?? [],
    );
    assert.ok(withheld.length > 0, JSON.stringify(admission?.deferredResources));
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
    for (const holderRange of withheld) {
      for (const range of granted?.ranges ?? []) {
        assert.equal(
          intersects(holderRange, range),
          false,
          `granted ${JSON.stringify(range)} overlaps the holder's ${JSON.stringify(holderRange)}`,
        );
      }
    }

    // On the record as a conversion driven by an arrival, against a holder
    // that had written nothing.
    const [declared] = await store.listAuditEvents({
      types: ["blanket_claim_declared"],
    });
    assert.notEqual(declared, undefined, "the conversion is not on the record");
    assert.equal(declared?.event.data["narrowedOnArrival"], true);
    assert.equal(
      declared?.event.data["observedFiles"],
      0,
      "the holder had written nothing when it was asked",
    );

    const lease = await store.getWorkLease(held.leaseId);
    assert.equal(lease?.plan?.plan.claim?.kind, "declared");
    assert.deepEqual(lease?.plan?.plan.expectedSymbols, [
      "holderOne",
      "holderTwo",
    ]);
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});

test("a holder that has ended is not asked by the next arrival", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: { files: ["src/shared.ts"], symbols: ["holderOne"] },
  });
  try {
    // The run ends first, which is what deregistration is for: a session
    // about to be cancelled must not be paused by somebody arriving late.
    held.agent.release.resolve();
    await held.finished;

    const second = await leaseFor(store, worker, "add a currency prefix", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: held.workspaces,
    });
    await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    assert.equal(
      held.agent.replans.length,
      0,
      "a holder whose run is over must not be paused",
    );
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});

test("a hanging pause does not stall the arrival's decision", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: { files: ["src/shared.ts"], symbols: ["holderOne"] },
    // Measured at fifty seconds in one run. Nothing anybody is waiting on may
    // be held open by it.
    pauseHangs: true,
    pauseTimeoutMs: 100,
  });
  try {
    const second = await leaseFor(store, worker, "add a currency prefix", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: held.workspaces,
      blanketAskTimeoutMs: 500,
    });

    const started = Date.now();
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 15_000,
      `the arrival waited ${String(elapsed)}ms on a pause that never returned`,
    );
    assert.equal(held.agent.pauses, 1);
    assert.equal(
      held.agent.replans.length,
      0,
      "a session that never paused must not be asked",
    );
    // Today's freeze, and today's answer for the arrival behind it: the claim
    // is narrowed to what the holder was granted against and carries no
    // symbols, so this plan waits for its retry. Never a grant.
    const lease = await store.getWorkLease(held.leaseId);
    assert.equal(lease?.plan?.plan.claim?.kind, "frozen");
    assert.ok(
      !isBlanketClaim(lease!.plan!.plan),
      "the claim should still have been narrowed",
    );
    assert.notEqual(
      decision.outcome,
      "admitted",
      `${JSON.stringify(decision)}`,
    );
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});

test("a hanging pause does not stall the holder's own teardown", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: { files: ["src/shared.ts"], symbols: ["holderOne"] },
    pauseHangs: true,
    // The holder's own timer, ticking fast, with somebody in the repository
    // for it to narrow against — so the ask is in flight when the run ends.
    pollMs: 50,
    pauseTimeoutMs: 100,
  });
  try {
    // Somebody else holds a lease, which is what makes the tick decide to
    // narrow at all. It never admits anything; it only has to exist.
    await leaseFor(store, worker, "somebody else entirely", real.version);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(held.agent.pauses > 0, "the tick never reached the ask");

    // `stop()` awaits the freeze in flight, so an unbounded pause here would
    // hold a settling task open for as long as an execution round may take.
    held.agent.release.resolve();
    assert.equal(await settle(held.finished), "finished", "the run never tore down");
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});

/**
 * The rest of the shape, driven through the same seam a run publishes but
 * without paying for a coordinator: what `watchBlanketClaim` registers is a
 * task and a closure, and these register exactly that.
 */

function stubWorkspaces(
  changes: Array<{ path: string; status: "modified" | "added" }>,
): WorkspaceManager {
  return {
    listWorkingChanges: async () => changes,
  } as unknown as WorkspaceManager;
}

/** A holder with a claim, a recorded worktree, and a live way to reach it. */
async function registeredHolder(options: {
  store: InMemoryCoordinationStore;
  worker: string;
  repository: CanonicalRepository;
  version: CanonicalVersion;
  estimatedFiles: string[];
  declare: () => Promise<{ files: string[]; symbols: string[] } | undefined>;
}): Promise<{
  task: TaskDefinition;
  leaseId: string;
  claim: AgentPlan;
  authority: LeasePlanAuthority;
  unregister: () => void;
}> {
  const holder = await leaseFor(
    options.store,
    options.worker,
    "rewrite the renderer",
    options.version,
  );
  const authority = new LeasePlanAuthority({
    store: options.store,
    leaseIdForTask: new Map([[holder.task.id, holder.leaseId]]),
  });
  const claim = await authority.claimRepository({
    task: holder.task,
    repository: options.repository,
    estimatedFiles: options.estimatedFiles,
    baseVersion: options.version,
  });
  assert.notEqual(claim, undefined, "the holder should hold the repository");
  const run = await options.store.createRun({
    repository: options.repository,
    mode: "coordinated",
    baseVersion: options.version,
  });
  await options.store.saveWorkspace(run.id, {
    id: "ws_holder",
    runId: run.id,
    taskId: holder.task.id,
    path: path.join(options.repository.path, "..", "holder"),
    isolation: "git-worktree",
    baseRevision: options.version.revision,
    createdAt: options.version.createdAt,
  });
  const unregister = registerBlanketHolder({
    task: holder.task,
    repositoryId: options.repository.id,
    declare: options.declare,
  });
  return { ...holder, claim: claim!, authority, unregister };
}

test("a conversion is not re-widened by a later tick", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const holder = await registeredHolder({
    store,
    worker,
    repository: real.repository,
    version: real.version,
    // Two files guessed at; the holder is in one of them and will name it.
    estimatedFiles: ["src/shared.ts", "src/quiet.ts"],
    declare: async () => ({ files: ["src/shared.ts"], symbols: ["holderOne"] }),
  });
  try {
    const second = await leaseFor(store, worker, "work on quiet", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([
        { path: "src/shared.ts", status: "modified" },
      ]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/quiet.ts"], ["quiet"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });
    assert.equal(
      decision.outcome,
      "admitted",
      `the arrival should have been granted the guess: ${JSON.stringify(decision)}`,
    );

    const converted = (await store.getWorkLease(holder.leaseId))!.plan!.plan;
    assert.equal(converted.claim?.kind, "declared");
    assert.ok(
      !converted.expectedFiles.includes("src/quiet.ts"),
      `the released guess is still held: ${converted.expectedFiles.join(", ")}`,
    );

    // Now the holder's own timer fires, carrying what the run had in memory
    // before any of this: the blanket claim and the whole estimate. It must
    // not overwrite the converted plan, and must not take back the file the
    // arrival is now running in.
    const afterTick = await holder.authority.freezeBlanketClaim({
      task: holder.task,
      plan: holder.claim,
      planRevision: 1,
      repository: real.repository,
      baseVersion: real.version,
      estimatedFiles: ["src/shared.ts", "src/quiet.ts"],
      observe: async () => [
        { path: "src/shared.ts", status: "modified" as const },
      ],
      declare: async () => ({ files: ["src/quiet.ts"], symbols: ["quiet"] }),
    });

    assert.equal(
      afterTick?.claim?.kind,
      "declared",
      "the tick should have been handed what the claim became",
    );
    assert.ok(
      !afterTick!.expectedFiles.includes("src/quiet.ts"),
      `the tick re-widened the plan: ${afterTick!.expectedFiles.join(", ")}`,
    );
    const durable = (await store.getWorkLease(holder.leaseId))!.plan!.plan;
    assert.deepEqual(durable.expectedFiles, converted.expectedFiles);
    assert.deepEqual(durable.expectedSymbols, converted.expectedSymbols);
    assert.equal(durable.claim?.kind, "declared");
  } finally {
    holder.unregister();
    await real.cleanup();
  }
});

test("the estimate's slack is still released to whoever asks for it", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const holder = await registeredHolder({
    store,
    worker,
    repository: real.repository,
    version: real.version,
    estimatedFiles: ["src/shared.ts", "src/quiet.ts"],
    declare: async () => ({ files: ["src/shared.ts"], symbols: ["holderOne"] }),
  });
  try {
    const second = await leaseFor(store, worker, "work on quiet", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([
        { path: "src/shared.ts", status: "modified" },
      ]),
    });
    await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/quiet.ts"], ["quiet"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    // Nine of ten estimated files are never opened. Releasing the ones
    // somebody is asking for is measured and valuable, and routing the
    // narrowing through the ask must not have cost it.
    const [narrowing] = (
      await store.listAuditEvents({
        types: ["blanket_claim_declared", "blanket_claim_frozen"],
      })
    ).filter((entry) => entry.event.data["narrowedOnArrival"] === true);
    assert.deepEqual(
      narrowing?.event.data["releasedFiles"],
      ["src/quiet.ts"],
      "what was handed over has to be on the record",
    );
    const converted = (await store.getWorkLease(holder.leaseId))!.plan!.plan;
    assert.ok(converted.expectedFiles.includes("src/shared.ts"));
    assert.ok(!converted.expectedFiles.includes("src/quiet.ts"));
  } finally {
    holder.unregister();
    await real.cleanup();
  }
});

test("three tasks arriving behind one holder ask it once", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  let asked = 0;
  const holder = await registeredHolder({
    store,
    worker,
    repository: real.repository,
    version: real.version,
    estimatedFiles: ["src/shared.ts"],
    declare: async () => {
      asked += 1;
      return { files: ["src/shared.ts"], symbols: ["holderOne"] };
    },
  });
  try {
    for (const objective of ["first arrival", "second arrival", "third"]) {
      const arrival = await leaseFor(store, worker, objective, real.version);
      const arriving = new LeasePlanAuthority({
        store,
        leaseIdForTask: new Map([[arrival.task.id, arrival.leaseId]]),
        workspaces: stubWorkspaces([]),
      });
      await arriving.admit({
        task: arrival.task,
        plan: candidatePlan(arrival.task.id, ["src/shared.ts"], ["candidateOne"]),
        planRevision: 1,
        baseVersion: real.version,
        repository: real.repository,
      });
    }
    // Pausing a working agent three times because three people started tasks
    // is not a cost this can carry — and the bound has to hold across the two
    // paths now that they are one.
    assert.equal(asked, 1, `the holder was paused ${String(asked)} times`);
  } finally {
    holder.unregister();
    await real.cleanup();
  }
});

test("a holder with no registered session is narrowed without being asked", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  let asked = 0;
  const holder = await registeredHolder({
    store,
    worker,
    repository: real.repository,
    version: real.version,
    estimatedFiles: ["src/shared.ts", "src/quiet.ts"],
    declare: async () => {
      asked += 1;
      return { files: ["src/shared.ts"], symbols: ["holderOne"] };
    },
  });
  // A worker-side authority, or an adapter without pause/requestReplan: there
  // is nothing published, so there is nothing to ask.
  holder.unregister();
  try {
    const second = await leaseFor(store, worker, "work on quiet", real.version);
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([
        { path: "src/shared.ts", status: "modified" },
      ]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/quiet.ts"], ["quiet"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    assert.equal(asked, 0, "an unaskable holder must never be asked");
    // And the arrival is no worse off than it is today: the estimate's slack
    // is released to it by the freeze, exactly as before.
    assert.equal(decision.outcome, "admitted", JSON.stringify(decision));
    const frozen = (await store.getWorkLease(holder.leaseId))!.plan!.plan;
    assert.equal(frozen.claim?.kind, "frozen");
    assert.ok(!frozen.expectedFiles.includes("src/quiet.ts"));
  } finally {
    await real.cleanup();
  }
});

/**
 * The whole point of the remote path, driven end to end.
 *
 * A task alone on somebody's laptop is handed the repository without planning.
 * Somebody else then arrives — and what must happen is not that the arrival
 * waits, and not that the holder is quietly stripped of ground it is standing
 * on. The holder is *paused, asked what the rest of its work needs, and
 * resumed*, and what it says becomes an ordinary plan naming files and symbols.
 * From that moment two agents can work in one repository, and in one file,
 * around each other's declarations.
 *
 * In-process this has worked since the ask existed. Across the wire every
 * piece of it is new: the holder answers over HTTP rather than through a
 * closure, and the observation it is frozen against is one it reported rather
 * than one this process read off a disk. What is asserted here is that the
 * arrival cannot tell the difference.
 */
test("a remote holder pauses, declares, and keeps files and symbols rather than the repository", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  let holderTaskId = "";
  try {
    // The holder: leased, and handed the repository by the claim route rather
    // than by a plan of its own.
    const held = await leaseFor(
      store,
      worker,
      "rename holderOne in src/shared.ts",
      real.version,
    );
    const { plan: claim } = await claimWorkRepository(
      store,
      { leaseId: held.leaseId, protocolVersion: WORKER_PROTOCOL_VERSION },
      { blanketClaims: true },
    );
    assert.ok(claim, "the solo task should have been given the repository");
    assert.equal(isBlanketClaim(claim), true);
    holderTaskId = held.task.id;

    // What it has written so far, as its heartbeat would have reported it.
    rememberWorkingChanges(held.task.id, [
      { path: "src/shared.ts", status: "modified" },
    ]);

    // The ask is delivered exactly once, and answered the way a paused agent
    // answers it — which on a real worker is a `requestReplan` round trip
    // posted back on its own route.
    const answering = (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const askId = askToDeliver(held.task.id);
        if (askId !== undefined) {
          settleDeclaration(
            held.task.id,
            askId,
            { files: ["src/shared.ts"], symbols: ["holderOne"] },
            [{ path: "src/shared.ts", status: "modified" }],
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    // And somebody arrives, wanting a different function in the same file.
    const second = await leaseFor(
      store,
      worker,
      "add a prefix to candidateOne",
      real.version,
    );
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([]),
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });
    await answering;

    // The claim is gone, and what replaced it names things rather than
    // everything — which is what lets the arrival into the same file.
    const converted = (await store.getWorkLease(held.leaseId))?.plan?.plan;
    assert.ok(converted);
    assert.equal(isBlanketClaim(converted), false);
    assert.ok(
      converted.expectedFiles.includes("src/shared.ts"),
      "the holder keeps the file it is working in",
    );
    assert.ok(
      converted.expectedSymbols.includes("holderOne"),
      "and the declaration it named, which is what the arrival is admitted around",
    );
    assert.equal(
      decision.outcome,
      "admitted",
      `the arrival should run: ${JSON.stringify(decision)}`,
    );
  } finally {
    releaseRemoteHolder(holderTaskId);
    await real.cleanup();
  }
});

/**
 * And an answer that has not come back yet is not an answer of "nothing".
 *
 * A freeze is permanent: it covers the estimate unioned with everything the
 * holder has touched, and is never narrowed again. Freezing on a slow answer
 * therefore throws that answer away and locks the repository for the rest of
 * the run — which is why the arrival is told to come back instead. The claim
 * stays blanket, which is the recoverable state.
 */
test("a remote holder that has not answered leaves its claim whole", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    const held = await leaseFor(
      store,
      worker,
      "rename holderOne in src/shared.ts",
      real.version,
    );
    const { plan: claim } = await claimWorkRepository(
      store,
      { leaseId: held.leaseId, protocolVersion: WORKER_PROTOCOL_VERSION },
      { blanketClaims: true },
    );
    assert.ok(claim);
    // Nothing reported and nothing answered: a laptop that has gone quiet.
    const second = await leaseFor(
      store,
      worker,
      "add a prefix to candidateOne",
      real.version,
    );
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: stubWorkspaces([]),
      blanketAskTimeoutMs: 50,
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: candidatePlan(second.task.id, ["src/shared.ts"], ["candidateOne"]),
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    const stillHeld = (await store.getWorkLease(held.leaseId))?.plan?.plan;
    assert.ok(stillHeld);
    assert.equal(
      isBlanketClaim(stillHeld),
      true,
      "an unanswered ask must not freeze the claim",
    );
    assert.notEqual(
      decision.outcome,
      "admitted",
      "and the arrival waits rather than being let into files nobody asked about",
    );
  } finally {
    await real.cleanup();
  }
});

/**
 * A task that cannot have the repository is still told where to start.
 *
 * Planning is not one inference: it is an agent reading its way into a
 * repository a tool call at a time, and most of that reading is a search for
 * something already computed — which files declare the names the objective
 * used, and where the repository has been working lately. The in-process
 * planner has been handed both for as long as they have existed. A remote
 * worker was handed neither and started every plan from nothing, which is the
 * same shape of gap as the missing claim, one layer down.
 *
 * Asserted on the contended case on purpose. That is the one a claim can never
 * help, and it is also the slow one.
 */
test("a contended remote task is told where the objective already lives", async () => {
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  try {
    // Somebody is already executing here, so no claim is possible.
    const holder = await leaseFor(store, worker, "work on quiet", real.version);
    assert.ok(holder.leaseId);
    const second = await leaseFor(
      store,
      worker,
      "add a prefix to candidateOne",
      real.version,
    );
    const prepared = await claimWorkRepository(
      store,
      { leaseId: second.leaseId, protocolVersion: WORKER_PROTOCOL_VERSION },
      { blanketClaims: true },
    );

    assert.equal(
      prepared.plan,
      undefined,
      "a repository with somebody in it cannot be claimed",
    );
    assert.ok(
      prepared.planningContext,
      "but the agent should still be told where to look",
    );
    assert.match(
      String(prepared.planningContext),
      /src\/shared\.ts/u,
      "the file that declares candidateOne",
    );
    // Offered as a starting point, never as a scope: an agent that adopted it
    // wholesale would plan the estimate instead of the task.
    assert.match(String(prepared.planningContext), /starting point|not a scope/iu);
  } finally {
    await real.cleanup();
  }
});
