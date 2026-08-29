import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { Coordinator } from "@coord/coordinator";
import { InMemoryCoordinationStore } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  createId,
  type AgentPlan,
  type CanonicalVersion,
  type ChangeSet,
  type ReplanRequest,
  type TaskDefinition,
} from "@coord/shared-types";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import { LeasePlanAuthority } from "./lease-admission.js";

/**
 * Chunk admission, driven end to end the way the deployment drives it.
 *
 * Every other test of the splitter calls `PlanAdmissionController.admit`
 * directly with a hand-built holder plan. That proves the splitter can split
 * and says nothing about whether the shape production actually produces ever
 * reaches it — and twice now it did not. The unit tests were green through
 * both bugs.
 *
 * What this drives instead is the whole path: a real repository, a real
 * coordinator run, a holder promoted alone and therefore handed a blanket
 * claim, the ask that converts that claim into declarations, and a second
 * authority arriving before any tick can fire. Nothing here is stubbed except
 * the agents themselves, and the agents only do what a vendor CLI does — plan,
 * write files, answer when asked.
 *
 * The scenario is the one reported from production, twice. The holder writes
 * in three files and names one. The arrival wants all three.
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
 * Five functions in the file both tasks want, so that withholding the holder's
 * two still leaves somewhere for the arrival to work. The other two files are
 * the ones the holder edits without naming.
 */
const PRICING = [
  "export function basePrice(item) {",
  "  return item.price;",
  "}",
  "",
  "export function lineTotal(item) {",
  "  return basePrice(item) * item.quantity;",
  "}",
  "",
  "export function applyDiscount(total, rate) {",
  "  return total - total * rate;",
  "}",
  "",
  "export function orderTotal(items) {",
  "  return items.reduce((sum, item) => sum + lineTotal(item), 0);",
  "}",
  "",
  "export function formatTotal(total) {",
  "  return total.toFixed(2);",
  "}",
  "",
].join("\n");

const PRICING_TEST = [
  "export function testLineTotal() {",
  "  return 1;",
  "}",
  "",
  "export function testOrderTotal() {",
  "  return 2;",
  "}",
  "",
].join("\n");

const CHECKOUT = [
  "export function renderCheckout(order) {",
  "  return order.id;",
  "}",
  "",
  "export function submitCheckout(order) {",
  "  return order;",
  "}",
  "",
  "export function checkoutSummary(order) {",
  "  return order.total;",
  "}",
  "",
].join("\n");

async function sharedRepository(): Promise<{
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  version: CanonicalVersion;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-chunk-e2e-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "test"), { recursive: true });
  await writeFile(
    path.join(source, "src", "order-pricing.js"),
    PRICING,
    "utf8",
  );
  await writeFile(
    path.join(source, "test", "order-pricing.test.js"),
    PRICING_TEST,
    "utf8",
  );
  await writeFile(path.join(source, "src", "checkout.js"), CHECKOUT, "utf8");
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
 * The holder from the report: granted the repository, writes in all three
 * files, and when it is paused and asked names exactly one of them.
 *
 * The two it does not name are the point. They land in `claim.held` — written
 * in, never declared — and it is those that used to cancel the split on the
 * file it did name.
 */
class HolderAgent implements AgentAdapter {
  public readonly replans: ReplanRequest[] = [];
  public readonly accepted: AgentPlan[] = [];
  public pauses = 0;
  /** Resolves once the holder is inside its edit phase with the claim. */
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
      declaration: { files: string[]; symbols: string[] };
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
    return {
      taskId: request.taskId,
      objective: "the rest of the pricing work",
      expectedFiles: [...this.options.declaration.files],
      expectedSymbols: [...this.options.declaration.symbols],
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
    // All three files, before anybody arrives. Only one of them will be named
    // when the ask comes; the freeze records the other two as held.
    const workspace = context.workspacePath;
    const edit = async (
      file: string,
      from: string,
      to: string,
    ): Promise<void> => {
      const target = path.join(workspace, file);
      const before = await readFile(target, "utf8");
      await writeFile(target, before.replace(from, to), "utf8");
    };
    await edit("src/order-pricing.js", "return item.price;", "return item.price * 1;");
    await edit("src/checkout.js", "return order.id;", "return String(order.id);");
    await edit("test/order-pricing.test.js", "return 1;", "return 1 + 0;");
    this.executing.resolve();
    await this.release.promise;
  }

  public async pause(): Promise<void> {
    this.pauses += 1;
  }

  public async resume(): Promise<void> {
    return undefined;
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
 * The other side of the same run: an agent that does exactly what it is told,
 * so that what it is told is what the test measures.
 */
class ArrivingAgent implements AgentAdapter {
  public readonly contexts: CoordinatorContext[] = [];
  private readonly sessions = new Map<
    string,
    { input: StartTaskInput; context?: CoordinatorContext }
  >();

  public constructor(
    private readonly options: {
      agentId: string;
      repository: CanonicalRepository;
      workspaces: WorkspaceManager;
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

  public async acceptBlanketClaim(): Promise<void> {
    throw new Error("an arrival must not be handed a blanket claim");
  }

  public async requestPlan(sessionId: string): Promise<AgentPlan> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      taskId: session.input.task.id,
      objective: "add a currency prefix where a total is shown",
      intent: "add a currency prefix",
      expectedFiles: [
        "src/order-pricing.js",
        "test/order-pricing.test.js",
        "src/checkout.js",
      ],
      expectedSymbols: ["formatTotal", "testOrderTotal", "checkoutSummary"],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    };
  }

  public async requestReplan(): Promise<AgentPlan> {
    throw new Error("the arrival was not expected to be asked to replan");
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
    this.contexts.push(structuredClone(context));
    const target = path.join(context.workspacePath, "src", "order-pricing.js");
    const before = await readFile(target, "utf8");
    await writeFile(
      target,
      before.replace("return total.toFixed(2);", "return `$${total.toFixed(2)}`;"),
      "utf8",
    );
  }

  public async pause(): Promise<void> {
    return undefined;
  }

  public async resume(): Promise<void> {
    return undefined;
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
      throw new Error("the arrival never entered its edit phase");
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
      agentExplanation: "did what it was told",
    });
  }

  public async streamEvents(
    _sessionId: string,
    _handler: (event: AgentEvent) => void,
  ): Promise<void> {
    return undefined;
  }
}

async function holdingRun(options: {
  root: string;
  repository: CanonicalRepository;
  repositories: RepositoryService;
  version: CanonicalVersion;
  store: InMemoryCoordinationStore;
  worker: string;
  declaration: { files: string[]; symbols: string[] };
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
    "rewrite basePrice and lineTotal in order-pricing.js",
    options.version,
  );
  const agent = new HolderAgent({
    agentId: "agent-a",
    repository: options.repository,
    workspaces,
    declaration: options.declaration,
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
    workingChangePollMs: NEVER_TICKS_MS,
  });
  const finished = coordinator
    .run({
      repository: options.repository,
      workspaceRoot: path.join(options.root, "workspaces"),
      integrationRoot: path.join(options.root, "integration"),
      tasks: [{ task: holder.task, adapter: agent }],
    })
    .catch((error: unknown) => error);
  await Promise.race([
    agent.executing.promise,
    finished.then((result) => {
      throw new Error(`the holder never executed: ${JSON.stringify(result)}`);
    }),
  ]);
  return {
    agent,
    task: holder.task,
    leaseId: holder.leaseId,
    finished,
    workspaces,
  };
}

async function settle(
  finished: Promise<unknown>,
  budgetMs = 20_000,
): Promise<string> {
  return await Promise.race([
    finished.then(() => "finished"),
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("hung"), budgetMs);
      timer.unref?.();
    }),
  ]);
}

test("an arrival is chunk-admitted to the one file a claim does not cover", async () => {
  // The production shape end to end, and the regression this file exists for.
  //
  // The holder is promoted alone, so it is handed a blanket claim with no
  // planning round trip — 66% of executions start this way. It writes in three
  // files. The arrival lands, the ask fires, and the holder names one file and
  // two of its five functions. That leaves:
  //
  //   src/order-pricing.js         named — shareable around basePrice/lineTotal
  //   src/checkout.js              written in, never named — claim-held whole
  //   test/order-pricing.test.js   written in, never named — claim-held whole
  //
  // The arrival wants all three. Before the fix in `admitWithinFiles`, the
  // first claim-held path in the loop returned `undefined` for the whole plan,
  // so the arrival was sequenced holding nothing and the user saw "Executing
  // work holds src/checkout.js, test/order-pricing.test.js" — with the file it
  // could have had missing from the list, because that file was not the
  // claim's doing.
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: {
      files: ["src/order-pricing.js"],
      symbols: ["basePrice", "lineTotal"],
    },
  });

  try {
    const second = await leaseFor(
      store,
      worker,
      "add a currency prefix to totals",
      real.version,
    );
    // A second authority, as a second `runPendingTasks` would build, arriving
    // before any tick can fire.
    const arriving = new LeasePlanAuthority({
      store,
      leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
      workspaces: held.workspaces,
    });
    const decision = await arriving.admit({
      task: second.task,
      plan: {
        taskId: second.task.id,
        objective: "add a currency prefix where a total is shown",
        intent: "add a currency prefix",
        // Every file the holder is in, and nothing else. No free file to fall
        // back on — that is what forces the decision through `admitWithinFiles`
        // rather than the path-level split, and it is the case the user's own
        // test was designed to produce.
        expectedFiles: [
          "src/order-pricing.js",
          "test/order-pricing.test.js",
          "src/checkout.js",
        ],
        expectedSymbols: ["formatTotal", "testOrderTotal", "checkoutSummary"],
        dependencies: [],
        commands: [],
        externalAccess: [],
        riskLevel: "low",
      },
      planRevision: 1,
      baseVersion: real.version,
      repository: real.repository,
    });

    // The ask has to have happened, or the claim is still blanket and none of
    // the rest of this means anything.
    assert.equal(held.agent.replans.length, 1, "the holder was never asked");
    assert.equal(held.agent.pauses, 1, "the holder was never paused to be asked");

    assert.equal(
      decision.outcome,
      "admitted",
      `the arrival was refused outright: ${JSON.stringify(decision)}`,
    );

    const admission = decision.admission;
    assert.notEqual(admission, undefined, "an admitted decision carried no admission");
    const granted = admission!.ownershipGrants.filter(
      (lease) => lease.resourceType === "file",
    );
    assert.deepEqual(
      granted.map((lease) => lease.resourceId),
      ["src/order-pricing.js"],
      "the shareable file was not the one and only file granted",
    );

    // And granted as a hole, not whole: the holder's two declared functions
    // sit at lines 1-3 and 5-7 of the placed index, so a grant that starts at
    // line 1 would be handing over code the holder is inside.
    const ranges = granted[0]?.ranges ?? [];
    assert.ok(ranges.length > 0, "the file was granted whole, not divided");
    assert.ok(
      ranges.every((range) => range.startLine >= 4),
      `the grant reached into the holder's own functions: ${JSON.stringify(ranges)}`,
    );

    // Both unnamed files stay with the holder, whole.
    const deferredIds = (admission!.deferredResources ?? []).map(
      (resource) => `${resource.resourceType}:${resource.resourceId}`,
    );
    for (const file of ["src/checkout.js", "test/order-pricing.test.js"]) {
      assert.ok(
        deferredIds.includes(`file:${file}`),
        `${file} was not deferred to its holder: ${JSON.stringify(deferredIds)}`,
      );
    }
    // As do the two functions it named.
    for (const symbol of ["basePrice", "lineTotal"]) {
      assert.ok(
        deferredIds.includes(`symbol:${symbol}`),
        `${symbol} was granted away from its holder: ${JSON.stringify(deferredIds)}`,
      );
    }
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});

test("a partially admitted agent is told what it was granted", async () => {
  // The split firing is only half of it. The other half is the agent finding
  // out, and on the in-process coordinator path it did not.
  //
  // The wave loop stored `entry.admission` — needed later, so collection can
  // tell "withheld, somebody else is writing it" from "never arbitrated" —
  // but built `entry.decision` from wave scheduling alone: "Approved for the
  // next non-conflicting execution wave", no constraints, no ranges. That
  // object is what `sendContext` hands the agent. So an agent that had just
  // been granted one file around two of its functions was told it was
  // approved, full stop.
  //
  // What follows is not a near miss. Believing it owns the file, the agent
  // edits the holder's function; `splitChangeSet` divides that hunk back out;
  // and where the withheld symbols were the bulk of the work the granted
  // patch set comes back empty and the whole task is requeued. The agent run
  // is spent and thrown away — the exact outcome partial admission exists to
  // prevent, reached by way of partial admission.
  //
  // The remote path never had this: `worker.ts` builds its decision straight
  // from the admission. Only the in-process coordinator dropped it, so the
  // same admission was followable over the wire and not in the same process.
  const real = await sharedRepository();
  const { store, worker } = await seed(real.repository);
  const held = await holdingRun({
    ...real,
    store,
    worker,
    declaration: {
      files: ["src/order-pricing.js"],
      symbols: ["basePrice", "lineTotal"],
    },
  });

  try {
    const second = await leaseFor(
      store,
      worker,
      "add a currency prefix to totals",
      real.version,
    );
    const agent = new ArrivingAgent({
      agentId: "agent-b",
      repository: real.repository,
      workspaces: held.workspaces,
    });
    // A real coordinator run rather than a bare `admit` call — the gap was
    // entirely between the authority's answer and what the run did with it,
    // so a test that calls `admit` directly cannot see it.
    const coordinator = new Coordinator({
      repositories: real.repositories,
      workspaces: held.workspaces,
      store,
      planAuthority: new LeasePlanAuthority({
        store,
        leaseIdForTask: new Map([[second.task.id, second.leaseId]]),
        workspaces: held.workspaces,
      }),
      workingChangePollMs: NEVER_TICKS_MS,
    });
    await Promise.race([
      coordinator
        .run({
          repository: real.repository,
          workspaceRoot: path.join(real.root, "workspaces-b"),
          integrationRoot: path.join(real.root, "integration-b"),
          tasks: [{ task: second.task, adapter: agent }],
        })
        .catch((error: unknown) => error),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 90_000);
        timer.unref?.();
      }),
    ]);

    assert.equal(
      agent.contexts.length,
      1,
      "the arrival never reached its edit phase",
    );
    const decision = agent.contexts[0]!.decision;
    assert.equal(
      decision.decision,
      "approved_with_constraints",
      `the agent was told a partial admission was a plain approval: ${decision.explanation}`,
    );
    assert.ok(
      decision.explanation.startsWith("Partially admitted"),
      `the agent got the scheduling explanation, not the admission's: ${decision.explanation}`,
    );
    // The one that matters: it has to be able to tell which lines are not its
    // own, or it cannot avoid them.
    const constraints = decision.constraints.join("\n");
    for (const symbol of ["basePrice", "lineTotal"]) {
      assert.ok(
        constraints.includes(symbol),
        `nothing told the agent to stay out of ${symbol}: ${JSON.stringify(decision.constraints)}`,
      );
    }
    assert.ok(
      constraints.includes("src/checkout.js") &&
        constraints.includes("test/order-pricing.test.js"),
      `the deferred files were never named to the agent: ${JSON.stringify(decision.constraints)}`,
    );
  } finally {
    held.agent.release.resolve();
    await settle(held.finished);
    await real.cleanup();
  }
});
