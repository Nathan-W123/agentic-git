import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import {
  CodexAdapter,
  type CodexProcessRunner,
} from "@coord/adapter-codex";
import {
  PROMPT_CLI_EFFORTS,
  createClaudeAdapter,
  createCopilotAdapter,
  createCursorAdapter,
  createGeminiAdapter,
  createKiroAdapter,
  type PromptCliEffort,
} from "@coord/adapter-prompt-cli";
import type {
  AgentAdapter,
  AgentEvent,
  AgentTokenUsage,
} from "@coord/agent-protocol";
import {
  WORKER_PROTOCOL_VERSION,
  derivedRepositoryParallelism,
  type WorkAssignment,
} from "@coord/cli/worker-operations";
import {
  codexExecutionSandbox,
  withModelOverride,
} from "@coord/cli/commands";
import type { AgentConfig, CoordinatorProject } from "@coord/cli/project";
// The exact words an in-process holder is asked with. Shared rather than
// restated: two askers with two promptings would get two different kinds of
// answer to a question whose whole value is that it is answered the same way.
import { BLANKET_DECLARATION_REASON } from "@coord/coordinator";
import { DEFAULT_PROJECT_ID } from "@coord/persistence";
import { GitClient } from "@coord/repository-service";
import {
  planAdmissionApproved,
  requestFromObjective,
  type AgentPlan,
  type ChangeSet,
  type CoordinatorDecision,
  type CanonicalChangeNotice,
  type PlanAdmission,
  type ScopeChangeDecision,
  type ScopeChangeRequest,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import {
  LeaseLostError,
  WorkerClient,
  isTransportFailure,
  type HeartbeatReply,
  type WorkingChange,
} from "./client.js";
import { holdHost, signalHost } from "./host-signal.js";
import { stageMcpServers, type StagedMcpServers } from "./mcp-config.js";
import type { WorkNudge } from "./nudge.js";
import {
  shouldClaimWork,
  systemPowerSource,
  type PowerSource,
} from "./power.js";

/**
 * The worker daemon.
 *
 * It owns nothing durable. Each iteration leases one task, rebuilds the
 * workspace from a bundle, has its agent plan, gets that plan admitted by the
 * control plane, runs the agent, returns a changeset, and deletes everything.
 * If it dies at any point the lease lapses and the control plane hands the
 * task to someone else.
 *
 * Planning before admission is what keeps a conflict cheap. An agent that is
 * going to collide with executing work is stopped after one planning round
 * trip, before it edits a line, rather than after a full execution that the
 * control plane would then discard.
 */

/**
 * A plan this fleet has already paid for, and where canonical went next.
 *
 * `baseRevision` is what the plan was written against. `advancedTo` is filled
 * in when the control plane refused the plan because canonical moved and told
 * us exactly what moved; it is what turns the next attempt into an amendment
 * rather than a cold start.
 */
interface CachedPlan {
  plan: AgentPlan;
  baseRevision: string;
  advancedTo?: CanonicalChangeNotice;
}

export interface WorkerOptions {
  client: WorkerClient;
  project: CoordinatorProject;
  workspaceRoot: string;
  /**
   * The organization this worker registers into, and the only one it can
   * lease work from. Required rather than inferred: a worker's tenant is a
   * deployment decision, not something to guess from the token's memberships.
   */
  organizationId: string;
  name?: string;
  version?: string;
  projectId?: string;
  repositoryId?: string;
  /**
   * The adapters this host can actually drive, if it knows.
   *
   * Left undefined, the project config is taken at its word, which is what a
   * server-side worker wants: it is the deployment, and its config is the
   * truth. A desktop is not — it has just looked at the machine and knows
   * which vendor CLIs are installed — and the config it reads has had absent
   * vendors backfilled into it by design. This is where that host says so.
   */
  adapters?: readonly string[];
  /** Injected only by tests or embedded runtimes. */
  codexRunner?: CodexProcessRunner;
  /**
   * How this machine answers "am I plugged in".
   *
   * Injected for the same reason `codexRunner` is: the real one shells out to
   * a platform tool, so a test that wants a worker on battery would otherwise
   * have to be running on a laptop that was actually unplugged.
   */
  powerSource?: PowerSource;
  /**
   * An optional shortcut out of the idle wait.
   *
   * Supplied by the daemon entry point, which is where the server address and
   * token live. Absent everywhere else — including every test — and the loop
   * below is written so that absence is simply the old behaviour.
   */
  nudge?: WorkNudge;
  /**
   * Plans already paid for, reusable while the base they were written against
   * has not moved.
   *
   * A task deferred at admission goes back to the queue, and the next lease
   * used to buy a whole fresh planning round from the model to rediscover the
   * plan it already had. `awaitAdmission` already resubmits an unchanged plan
   * without re-planning, but only for `planWaitBudgetMs`; past that the work
   * is thrown away. Measured on the A/B series, that is where the coordinated
   * arm's replans come from: 22 in one run, 11 in another.
   *
   * **The reuse is only ever safe against an identical base revision**, which
   * is the whole of the guard: the key is `taskId` and `baseRevision`
   * together, so a canonical that moved cannot match, and the plan is
   * arbitrated exactly as a fresh one would be. Nothing about conflict
   * detection changes — the same plan meets the same admission.
   *
   * Supply a shared map to let several workers in one process reuse each
   * other's plans; the default is per-worker, which is the right scope when
   * workers are separate processes.
   */
  planCache?: Map<string, CachedPlan>;
  /**
   * How many tasks this machine will run at once.
   *
   * A worker used to hold one lease and await it, which is what a machine
   * running one agent needs and nothing more. It is not what the control
   * plane does: a server-side run leases up to the repository's parallelism
   * bound and executes the whole wave together, so moving execution onto
   * people's own machines quietly took a four-wide fleet down to one — the
   * queue was doing exactly what it was told, one task at a time, and looked
   * for all the world like a stuck coordinator.
   *
   * Defaults to {@link derivedRepositoryParallelism}, the same memory-derived
   * figure the control plane sizes a repository by, so a machine offers what
   * it can actually hold rather than a number somebody picked. Deployments
   * set `COORD_WORKER_CONCURRENCY`; `1` is the old behaviour exactly.
   *
   * The repository's own bound still applies on top and is the one that
   * matters for correctness: a worker that asks for more than a repository
   * admits is simply not granted the extra leases.
   */
  concurrency?: number;
  /** Idle wait between polls when the queue is empty. */
  pollIntervalMs?: number;
  /**
   * How long to keep resubmitting a deferred plan before handing the lease
   * back. Waiting keeps the already-paid planning work; giving up keeps a
   * repository slot from being held by a task that cannot start.
   */
  planWaitBudgetMs?: number;
  /**
   * How long to hold a lease whose plan is waiting on a human reviewer.
   *
   * Deliberately separate from {@link planWaitBudgetMs}: that budget is sized
   * for another worker letting go of a resource, which happens in seconds,
   * while this one is sized for a person noticing a review request. Giving up
   * on the ordinary budget would throw away an approval already in someone's
   * queue and make the next lease ask for it again.
   */
  planApprovalWaitMs?: number;
}

export interface IterationResult {
  worked: boolean;
  taskId?: string;
  accepted?: boolean;
  reason?: string;
  /**
   * The plan was refused before execution. Not a failure: the task is back in
   * the queue and no agent execution time was spent on it.
   */
  deferred?: boolean;
  /**
   * Resources the control plane withheld while admitting the rest of the plan.
   * Present only on a partial admission, where the task ran on what it was
   * granted and the remainder was queued as a follow-up task.
   */
  deferredResources?: string[];
  /**
   * The iteration ended because the control plane could not be reached, not
   * because anything about the task was wrong. The lease was released and the
   * task is queued again; a harness counting failures should count these
   * apart, because attributing them to coordination is how an infrastructure
   * problem gets mistaken for a scheduling result.
   */
  transport?: boolean;
}

const DEFAULT_POLL_MS = 5_000;

/**
 * How many tasks this machine will hold at once.
 *
 * Deliberately the control plane's own sizing rather than a second formula:
 * "how many agents fit on this box" is one question, and this repository has
 * answered it once already, in memory rather than in cores. A worker with its
 * own guess would drift from the bound its leases are granted against, which
 * is the shape of bug that keeps being found here.
 */
function configuredConcurrency(explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isSafeInteger(explicit) || explicit < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    return explicit;
  }
  const raw = process.env["COORD_WORKER_CONCURRENCY"]?.trim() ?? "";
  if (raw === "") {
    return derivedRepositoryParallelism();
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(
      "COORD_WORKER_CONCURRENCY must be a positive integer",
    );
  }
  return parsed;
}

/**
 * Where a task's minutes went, said once when it ends.
 *
 * Running agents on a laptop instead of in the datacentre changes what is
 * expensive, and nothing here reported which part. "It feels slower than it
 * was on the server" is a real observation with no way to act on it: a
 * checkout that takes ninety seconds because an antivirus is reading every
 * file it writes, a first bundle arriving over a home connection, and a model
 * simply taking its time are three completely different problems that look
 * identical from outside.
 *
 * Deliberately one line rather than a metrics system. It is printed to the
 * worker's own output, which the desktop app now keeps, so the answer to "why
 * was that slow" is a thing somebody can read rather than a thing somebody has
 * to reproduce.
 */
class Laps {
  private readonly marks: [string, number][] = [];
  private last = Date.now();
  private readonly startedAt = Date.now();

  /** Closes the stretch since the previous mark and names it. */
  public mark(name: string): void {
    const now = Date.now();
    this.marks.push([name, now - this.last]);
    this.last = now;
  }

  /** Everything measured, longest phase named first among equals. */
  public summary(): string {
    const parts = this.marks
      .filter(([, ms]) => ms >= 50)
      .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`);
    return `${parts.join(" · ")} · total ${(
      (Date.now() - this.startedAt) / 1000
    ).toFixed(1)}s`;
  }
}
const DEFAULT_PLAN_WAIT_BUDGET_MS = 60_000;
/**
 * How long any one git command may take before the task is failed.
 *
 * Every git call here used to run with no deadline at all, and that is the
 * shape of a task that is claimed and then simply never heard from again. The
 * heartbeat runs on its own timer, so it goes on renewing the lease every
 * sixty seconds for as long as the process is alive — which means a git
 * command blocked on stalled I/O, a half-open connection, an antivirus
 * holding a pack file, or a network-backed directory is not a slow task, it
 * is a permanent one. Nothing on the control plane can rescue it either:
 * lease expiry is clock-based against that heartbeat, and the stranded-work
 * sweep explicitly skips anything whose lease is still active. So the task
 * sits claimed forever, with no failure, because nothing anywhere is capable
 * of deciding that it has gone wrong.
 *
 * Generous on purpose. A first cold fetch of a large repository over a poor
 * connection is legitimately minutes, and failing that would be worse than
 * the bug. Twenty minutes is far past anything healthy and far short of
 * forever, and a task that ends here ends *loudly*: `runProcess` reports a
 * timeout as exit 124, `GitClient.run` throws on it, and the worker's catch
 * reports a failure the room can read.
 */
const GIT_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;

/** A working day, so a review request raised in the morning is still live. */
const DEFAULT_PLAN_APPROVAL_WAIT_MS = 8 * 60 * 60 * 1000;
const MIN_PLAN_RETRY_MS = 1_000;

/** A lease id is remote input, so it never becomes a filesystem segment. */
export function workerScratchPath(
  workspaceRoot: string,
  leaseId: string,
): string {
  const digest = createHash("sha256")
    .update(leaseId, "utf8")
    .digest("hex")
    .slice(0, 24);
  return path.join(path.resolve(workspaceRoot), `lease-${digest}`);
}

/** Everything the agent side holds between planning and execution. */
interface PlannedWork {
  adapter: AgentAdapter;
  sessionId: string;
  plan: AgentPlan;
  workspaceId: string;
  workspacePath: string;
}

/**
 * Whether this reads as an adapter's "nothing to say" fallback.
 *
 * All three build it the same way — `<agent name> completed <request>`, where
 * the request is derived from the objective by `requestFromObjective`. The
 * check is anchored on the tail rather than on the name, because names differ
 * per adapter and per configured profile while the tail is computed from the
 * objective this worker is already holding.
 *
 * A false positive costs one honest "I could not answer that just now" on an
 * answer that genuinely ended with those exact words. A false negative posts
 * somebody their own question back as though an agent had written it. That
 * asymmetry is the whole reason the tail is matched exactly rather than
 * loosely.
 */
function readsAsCompletionNotice(said: string, objective: string): boolean {
  const request = requestFromObjective(objective).trim();
  if (request.length === 0) {
    return false;
  }
  return said.trim().endsWith(`completed ${request}`);
}

/**
 * Everything one leased task owns while it is running.
 *
 * This was eight fields on the worker itself, which was right for exactly as
 * long as a worker ran one task at a time. A machine holding four leases has
 * four sessions to cancel, four claims to report writes under and four
 * admission waits to abort; on one set of fields the second run's session
 * overwrites the first's, and from then on the worker cancels the wrong agent
 * and reports the wrong plan. Nothing in here is shared between runs, which is
 * the property that makes the wave safe.
 */
class Run {
  /** The agent turn in flight, if one is. Undefined between phases. */
  public session: { adapter: AgentAdapter; sessionId: string } | undefined;
  /** The cancel already issued, so a second request joins it. */
  public cancellation: Promise<void> | undefined;
  public cancellationRequested = false;
  /** Aborted to cut short a wait between admission retries. */
  public readonly admissionWait = new AbortController();
  /**
   * The stretch timings for the task in hand, so the phases inside `plan` can
   * be named by the code that runs them rather than measured from outside.
   */
  public laps: Laps | undefined;
  /**
   * The plan the control plane narrowed this run's claim to, if it did.
   *
   * Reported instead of the claim at the end. The result is checked against
   * the contract on the lease, and after a narrowing that contract is the
   * frozen plan — a run that reported the blanket claim it started with would
   * be claiming resources the admitted plan no longer covers, and refused for
   * it. What the worker reports has to be what the control plane last decided.
   */
  public adoptedPlan: AgentPlan | undefined;
  /**
   * The repository claim this run is currently holding, if it is.
   *
   * Kept because both halves of a claim's life happen outside the call that
   * granted it: the heartbeat reports what has been written under it, and the
   * heartbeat's reply is where it learns the claim has been narrowed. Cleared
   * the moment it stops being blanket, which is what stops a narrowed holder
   * going on reporting as though it still had the repository.
   */
  public claim:
    | {
        adapter: AgentAdapter;
        sessionId: string;
        plan: AgentPlan;
        workspace: TaskWorkspace;
        workspaces: WorkspaceManager;
      }
    | undefined;

  public constructor(public readonly leaseId: string) {}
}

export class Worker {
  private identity: { id: string } | undefined;
  /** See {@link WorkerOptions.planCache}. Per-worker unless one is injected. */
  private readonly plans: Map<string, CachedPlan>;
  /** Reused plans this worker did not have to buy again. */
  public planReuseCount = 0;
  /** Plans amended from a previous one rather than written from nothing. */
  public planAmendCount = 0;
  private stopping = false;
  /**
   * Every task this machine is holding a lease for right now.
   *
   * The set is what {@link stop} cancels and what {@link concurrency} is
   * measured against; a run adds itself the moment it has a lease and removes
   * itself in the `finally` that releases it, so a slot is never held by a run
   * that has ended.
   */
  private readonly runs = new Set<Run>();
  /**
   * Serialises work on the shared repository cache, one chain per repository.
   *
   * The cache is one bare repository per repository id and every run fetches
   * into it. Concurrently that is not merely slow: git takes a ref lock, the
   * loser's fetch fails, and the failure path deletes the cache — out from
   * under the run that is still using it, which then rebuilds it, which fails
   * the next one. The whole hazard is inside `updateCache`, so the chain is
   * held for exactly that call and dropped before the checkout, which is the
   * long part and touches only the run's own workspace.
   */
  private readonly cacheChains = new Map<string, Promise<unknown>>();
  /** See {@link WorkerOptions.powerSource}. */
  private readonly power: PowerSource;

  /**
   * See {@link WorkerOptions.concurrency}.
   *
   * Read once. The environment does not change under a running daemon, and a
   * bad value should stop the worker starting rather than throw from inside
   * its poll loop, where a daemon is built to survive throwing.
   */
  private readonly concurrency: number;

  public constructor(private readonly options: WorkerOptions) {
    this.plans = options.planCache ?? new Map<string, CachedPlan>();
    this.power = options.powerSource ?? systemPowerSource();
    this.concurrency = configuredConcurrency(options.concurrency);
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const planWaitBudget =
      options.planWaitBudgetMs ?? DEFAULT_PLAN_WAIT_BUDGET_MS;
    const approvalWait =
      options.planApprovalWaitMs ?? DEFAULT_PLAN_APPROVAL_WAIT_MS;
    if (!Number.isSafeInteger(pollInterval) || pollInterval < 1) {
      throw new RangeError("pollIntervalMs must be a positive integer");
    }
    if (!Number.isSafeInteger(planWaitBudget) || planWaitBudget < 0) {
      throw new RangeError(
        "planWaitBudgetMs must be a non-negative integer",
      );
    }
    if (!Number.isSafeInteger(approvalWait) || approvalWait < 0) {
      throw new RangeError(
        "planApprovalWaitMs must be a non-negative integer",
      );
    }
  }

  public get workerId(): string | undefined {
    return this.identity?.id;
  }

  public async register(): Promise<string> {
    const configured = new Set(
      Object.values(this.options.project.config.agents).map(
        (agent) => agent.adapter ?? "generic-cli",
      ),
    );
    // What the config lists is not what this machine can run. `CoordinatorProject`
    // backfills a default agent for every vendor the config lacks — on purpose,
    // so a deployment that predates a vendor still answers for it — and those
    // entries carry no command. A worker that registered them would be offered
    // work for a CLI that is not installed and could only fail it, which is the
    // "spawn <vendor> ENOENT" a desktop kept reporting. So the host may say what
    // it actually has, and registration is the intersection.
    const advertised =
      this.options.adapters === undefined
        ? [...configured]
        : [...configured].filter((adapter) =>
            this.options.adapters?.includes(adapter),
          );
    const adapters = advertised;
    const identity = await this.options.client.register({
      organizationId: this.options.organizationId,
      name: this.options.name ?? `worker-${process.pid}`,
      adapters,
      version: this.options.version ?? "0.0.0",
    });
    this.identity = identity;
    return identity.id;
  }

  /** How many tasks this machine will hold at once. */
  public get concurrencyLimit(): number {
    return this.concurrency;
  }

  /** How many tasks it is holding right now. */
  public get activeRunCount(): number {
    return this.runs.size;
  }

  /**
   * Performs at most one unit of work.
   *
   * Separated from {@link run} so the whole cycle can be driven directly by a
   * test without an infinite loop.
   *
   * `onLeased` fires the moment this call is holding a lease, which is how
   * {@link run} knows a slot has actually been taken without waiting for the
   * agent to finish using it. A call that finds nothing queued never fires it.
   */
  public async runOnce(hooks?: {
    readonly onLeased?: () => void;
  }): Promise<IterationResult> {
    if (this.stopping) {
      return { worked: false };
    }
    // The bound this machine placed on itself, checked here rather than only
    // in `run` so that a caller driving iterations directly cannot walk past
    // it. `run` awaits `onLeased` before starting the next iteration, so the
    // count this reads is never stale by a lease.
    if (this.runs.size >= this.concurrency) {
      throw new Error(
        `This worker is already running ${this.runs.size} tasks, which is its limit`,
      );
    }
    return await this.performIteration(hooks?.onLeased);
  }

  private async performIteration(
    onLeased?: () => void,
  ): Promise<IterationResult> {
    const workerId = this.identity?.id ?? (await this.register());
    // Asked before the lease and not after it, because the point is to never
    // hold work this machine cannot promise to finish. A laptop that claims a
    // task and then sleeps keeps it for the full lease expiry while its owner
    // watches nothing happen; declining leaves it visibly queued instead.
    if (!shouldClaimWork(await this.power.read())) {
      return { worked: false };
    }
    const assignment = await this.options.client.lease(
      workerId,
      this.options.projectId ?? DEFAULT_PROJECT_ID,
      this.options.repositoryId,
      // Opting in is what makes this worker able to receive a question at
      // all. A build that does not send this is served work only, by an
      // older control plane that ignores the field and by a newer one that
      // defaults to the same thing — which is why no protocol version moved.
      ["task", "question"],
    );
    if (assignment === undefined) {
      return { worked: false };
    }
    if (this.stopping) {
      // stop() may race an in-flight lease request. Hand back anything that
      // arrived after shutdown began instead of starting new agent work.
      await this.options.client
        .release(assignment.lease.id)
        .catch(() => undefined);
      return { worked: false };
    }
    if (
      !Number.isSafeInteger(assignment.heartbeatIntervalMs) ||
      assignment.heartbeatIntervalMs < 1
    ) {
      await this.options.client
        .release(assignment.lease.id)
        .catch(() => undefined);
      return {
        worked: true,
        taskId: assignment.task.id,
        accepted: false,
        reason: "Control plane returned an invalid heartbeat interval",
      };
    }

    const run = new Run(assignment.lease.id);
    this.runs.add(run);
    onLeased?.();
    // The busy window is exactly the lease's lifetime. The desktop app holds
    // the machine awake for this and nothing longer, so that volunteering a
    // laptop does not mean it never sleeps again. Counted rather than
    // switched: with several runs in flight the first one to finish would
    // otherwise tell the host it was idle and let the machine sleep on top of
    // three agents that were still working.
    const releaseHost = holdHost();
    const scratch = workerScratchPath(
      this.options.workspaceRoot,
      assignment.lease.id,
    );

    // Heartbeat runs alongside execution: an agent can take many minutes, far
    // longer than the lease, so without this the control plane would reclaim a
    // task that is still being worked on.
    let leaseLost = false;
    let heartbeat: Promise<void> | undefined;
    const beat = setInterval(() => {
      if (heartbeat !== undefined || leaseLost) {
        return;
      }
      heartbeat = (async () => {
        // Only while a claim is held. A run that planned its own scope has
        // nothing to report and nothing that could be narrowed, so its
        // heartbeat stays the call it always was.
        const changes = await this.claimedWorkingChanges(run);
        const reply = await this.options.client.heartbeat(
          assignment.lease.id,
          this.spentSoFar(run),
          changes,
        );
        await this.answerClaimTraffic(run, assignment, reply);
      })()
        .catch(async (error) => {
          if (error instanceof LeaseLostError) {
            leaseLost = true;
            await this.cancelSession(run);
          }
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, Math.max(1_000, assignment.heartbeatIntervalMs));
    beat.unref?.();

    try {
      if ((assignment.protocolVersion ?? 1) < WORKER_PROTOCOL_VERSION) {
        // Executing anyway would put the old plan-blind behaviour back: work
        // would be done first and discarded on conflict afterwards.
        throw new Error(
          "Control plane speaks remote worker protocol " +
            `${assignment.protocolVersion ?? 1}, which has no plan admission ` +
            `step; this worker requires ${WORKER_PROTOCOL_VERSION}`,
        );
      }

      if (assignment.task.kind === "question") {
        const answer = await this.answerQuestion(run, assignment, scratch);
        if (leaseLost) {
          throw new LeaseLostError(assignment.lease.id);
        }
        const said = await this.options.client.report(
          assignment.lease.id,
          // No plan and no changeset, because there was nothing to admit and
          // nothing to integrate. The control plane's question branch returns
          // before it looks for either.
          { status: "completed", plan: null, changeSet: null, answer },
          this.spentSoFar(run),
        );
        return {
          worked: true,
          taskId: assignment.task.id,
          accepted: said.accepted,
          ...(said.reason === undefined ? {} : { reason: said.reason }),
        };
      }

      const laps = new Laps();
      run.laps = laps;
      const planned = await this.plan(run, assignment, scratch);
      laps.mark("plan");
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const admission = await this.awaitAdmission(run, assignment, planned.plan);
      laps.mark("admission");
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      if (!planAdmissionApproved(admission)) {
        // Canonical moved under this plan and the control plane said exactly
        // where it went. Remember that against the plan we already paid for,
        // so whoever leases this task next amends it instead of starting
        // cold. Stored only when the notice begins where this plan does; a
        // notice about some other stretch of history is not usable here.
        const remembered = this.plans.get(assignment.task.id);
        if (
          admission.canonicalChange !== undefined &&
          remembered !== undefined &&
          remembered.baseRevision ===
            admission.canonicalChange.previousVersion.revision
        ) {
          this.plans.set(assignment.task.id, {
            ...remembered,
            advancedTo: admission.canonicalChange,
          });
        }
        return await this.defer(assignment, planned, admission);
      }

      const result = await this.execute(run, assignment, planned, admission);
      laps.mark("execute");
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const accepted = await this.options.client.report(
        assignment.lease.id,
        {
          status: "completed",
          // Whatever the control plane last decided this run holds, which is
          // not always what it started with: a claim narrowed mid-run leaves
          // the frozen plan as the contract, and reporting the wider one is
          // reporting resources nobody granted.
          plan: run.adoptedPlan ?? result.plan,
          changeSet: result.changeSet,
        },
        this.spentSoFar(run),
      );
      laps.mark("report");
      // One line, on the worker's own output, which the desktop app keeps.
      // Everything above this is where the time actually went; without it
      // "slower than the server was" is an observation with nowhere to go.
      console.log(`[worker] task ${assignment.task.id} — ${laps.summary()}`);
      const withheld = (admission.deferredResources ?? []).map(
        (resource) => `${resource.resourceType}:${resource.resourceId}`,
      );
      return {
        worked: true,
        taskId: assignment.task.id,
        accepted: accepted.accepted,
        ...(withheld.length === 0 ? {} : { deferredResources: withheld }),
        ...(accepted.reason === undefined ? {} : { reason: accepted.reason }),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof LeaseLostError) {
        // The task belongs to someone else now; reporting would be a lie.
        return { worked: true, taskId: assignment.task.id, accepted: false, reason: detail };
      }
      // A task is failed when the *work* failed — the agent could not do it,
      // the plan was refused, the result would not validate. A control plane
      // this worker could not reach says nothing about any of that, and
      // failing the task on it discards work for a reason that has nothing to
      // do with the work. The client already retries a dropped connection; one
      // that outlives those retries means the control plane is unreachable
      // now, which is a condition that clears. So the lease is released
      // instead and the task goes back on the queue for whoever can reach it.
      if (isTransportFailure(error)) {
        await this.options.client
          .release(assignment.lease.id)
          .catch(() => undefined);
        return {
          worked: true,
          taskId: assignment.task.id,
          accepted: false,
          deferred: true,
          transport: true,
          reason: `control plane unreachable, task requeued: ${detail}`,
        };
      }
      await this.options.client
        .report(assignment.lease.id, { status: "failed", detail: detail.slice(0, 2000) })
        .catch(() => undefined);
      return { worked: true, taskId: assignment.task.id, accepted: false, reason: detail };
    } finally {
      clearInterval(beat);
      // Removed before the host is told, so a `stop` racing this cannot try to
      // cancel a run that has already released its lease, and so the slot is
      // free for the next task the moment this one is genuinely over.
      this.runs.delete(run);
      releaseHost();
      await heartbeat?.catch(() => undefined);
      await this.cancelSession(run);
      run.claim = undefined;
      run.adoptedPlan = undefined;
      run.session = undefined;
      run.cancellation = undefined;
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Runs one question and returns what the agent actually said.
   *
   * The same session machinery as work, because a question is answered the
   * same way work is done — a checkout, an agent, a turn — and the only real
   * differences are at the ends: nothing is admitted going in, and nothing is
   * integrated coming out. So the admission handed to `execute` is
   * synthesised rather than requested. That is honest rather than a shortcut:
   * admission exists to stop two agents editing the same files, a question
   * declares no files and edits none, and asking the control plane to admit
   * an empty plan would be asking a question whose answer is fixed.
   *
   * What comes back is the agent's own explanation, and the guard below is
   * the point of the whole method.
   */
  private async answerQuestion(
    run: Run,
    assignment: WorkAssignment,
    scratch: string,
  ): Promise<string> {
    const planned = await this.plan(run, assignment, scratch);
    const result = await this.execute(run, assignment, planned, {
      status: "approved",
      taskId: assignment.task.id,
      planRevision: 1,
      baseRevision: assignment.lease.baseRevision,
      ownershipGrants: [],
      constraints: [],
      blockedBy: [],
      conflicts: [],
      explanation: "A question declares no files, so there is nothing to admit.",
      decidedAt: new Date().toISOString(),
    });
    const said = (result.changeSet.agentExplanation ?? "").trim();
    // Every adapter falls back to "<name> completed <request>" when the model
    // returns no explanation of its own. For work that is a reasonable status
    // line. For a question it is a disaster: the request *is* the asker's own
    // sentence, so the room would get its own question handed back to it,
    // prefixed by the agent's name, indistinguishable from a real answer.
    //
    // Failing instead is not a worse outcome. A failed question becomes the
    // control plane's "I could not answer that just now", which is true, says
    // so, and cannot be mistaken for an answer.
    if (said.length === 0 || readsAsCompletionNotice(said, assignment.task.objective)) {
      throw new Error("The agent produced no answer of its own");
    }
    return said;
  }

  /**
   * Submits the plan and waits out a deferral.
   *
   * Waiting rather than immediately giving the task back preserves the
   * planning already paid for: the usual reason for a deferral is another
   * worker holding the same resources, and that clears on its own. Resubmitting
   * is a bare HTTP call — the agent sits idle, burning nothing.
   */
  private async awaitAdmission(
    run: Run,
    assignment: WorkAssignment,
    plan: AgentPlan,
  ): Promise<PlanAdmission> {
    const budget =
      this.options.planWaitBudgetMs ?? DEFAULT_PLAN_WAIT_BUDGET_MS;
    const approvalBudget =
      this.options.planApprovalWaitMs ?? DEFAULT_PLAN_APPROVAL_WAIT_MS;
    let deadline = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + budget);
    let admission = await this.options.client.submitPlan(
      assignment.lease.id,
      plan,
    );
    // Waiting on a reviewer is a different kind of waiting. The lease is kept
    // alive by the heartbeat either way, so extending the deadline costs only
    // the repository slot — which is the trade a project makes when it turns
    // the gate on.
    const extend = (current: PlanAdmission): void => {
      if (current.awaitingApproval === true) {
        deadline = Math.max(deadline, Date.now() + approvalBudget);
      }
    };
    extend(admission);
    while (
      !planAdmissionApproved(admission) &&
      // A requeue means canonical moved: the same plan can never be admitted
      // again, so waiting would be pointless.
      admission.requeue !== true &&
      !this.stopping &&
      !run.cancellationRequested &&
      Date.now() < deadline
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const requested =
        Number.isSafeInteger(admission.retryAfterMs) &&
        (admission.retryAfterMs ?? 0) > 0
          ? admission.retryAfterMs!
          : MIN_PLAN_RETRY_MS;
      const wait = Math.min(
        remaining,
        Math.max(MIN_PLAN_RETRY_MS, requested),
      );
      await this.waitForAdmissionRetry(run, wait);
      if (this.stopping || run.cancellationRequested) {
        break;
      }
      admission = await this.options.client.submitPlan(
        assignment.lease.id,
        plan,
      );
      extend(admission);
    }
    return admission;
  }

  private async waitForAdmissionRetry(
    run: Run,
    milliseconds: number,
  ): Promise<void> {
    const signal = run.admissionWait.signal;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      function finish(): void {
        signal.removeEventListener("abort", finish);
        clearTimeout(timer);
        resolve();
      }
      if (signal.aborted) {
        finish();
      } else {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  /**
   * Abandons a task whose plan was not admitted, without executing it.
   *
   * The lease goes back so another task can use the repository's concurrency
   * slot — except when the control plane already requeued it, which it does
   * when canonical moved out from under the plan.
   */
  private async defer(
    assignment: WorkAssignment,
    planned: PlannedWork,
    admission: PlanAdmission,
  ): Promise<IterationResult> {
    await planned.adapter.cancel(planned.sessionId).catch(() => undefined);
    if (admission.requeue !== true) {
      await this.options.client
        .release(assignment.lease.id)
        .catch(() => undefined);
    }
    return {
      worked: true,
      taskId: assignment.task.id,
      accepted: false,
      deferred: true,
      reason: `${admission.status}: ${admission.explanation}`,
    };
  }

  /**
   * Runs `work` with nothing else running against the same repository.
   *
   * A chain rather than a lock, because the thing being protected is a
   * sequence of git commands rather than a variable, and because a chain
   * cannot be forgotten: the link is installed before anything awaits and the
   * entry is dropped when nothing is queued behind it, so a worker does not
   * accumulate a promise per repository it has ever seen. A failing link is
   * caught before the next one runs — one run's broken cache must not stop
   * every later task in that repository.
   */
  private async serialisedByRepository<T>(
    repositoryId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cacheChains.get(repositoryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => await work());
    const guard = next.then(
      () => undefined,
      () => undefined,
    );
    this.cacheChains.set(repositoryId, guard);
    try {
      return await next;
    } finally {
      if (this.cacheChains.get(repositoryId) === guard) {
        this.cacheChains.delete(repositoryId);
      }
    }
  }

  /**
   * This machine's own copy of a repository, created once and kept.
   *
   * Keyed by repository id and held beside the worker's scratch space rather
   * than inside a lease, because outliving the lease is the entire point. A
   * bare repository: nothing is ever checked out here, it exists to hold
   * objects so a workspace can be filled from local disk instead of from the
   * network.
   *
   * `init` is safe to repeat — git leaves an existing repository alone — so
   * this is also the repair path. A cache that was deleted, or was never
   * there, is simply built again on the next task.
   */
  private async repositoryCache(
    git: GitClient,
    repositoryId: string,
  ): Promise<string> {
    // The id is a coordinator identifier rather than anything a person types,
    // but it becomes a path here, so it is reduced to characters that cannot
    // leave the directory they are meant to sit in.
    const safe = repositoryId.replace(/[^A-Za-z0-9._-]/gu, "_");
    const cache = path.join(this.options.workspaceRoot, "repositories", safe);
    await mkdir(path.dirname(cache), { recursive: true });
    await git.run(["init", "--bare", "--end-of-options", cache], {
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    return cache;
  }

  /**
   * Brings the cache up to the revision this lease needs, and says where to
   * fetch that revision from.
   *
   * The control plane is told what this machine already holds and answers
   * with only what is missing — a few commits rather than a repository. On a
   * first task there is nothing to name and the whole history arrives, which
   * is what every task used to do.
   *
   * A cache that cannot absorb the bundle is not worth arguing with: it is
   * abandoned and the lease is served straight from the bundle, which is
   * exactly the behaviour that came before this existed. Slow is a far better
   * failure than stuck, and a repository can be corrupted by things that are
   * none of the worker's business — a full disk, a killed process, an
   * antivirus quarantining a pack file.
   */
  private async updateCache(
    git: GitClient,
    cache: string,
    assignment: WorkAssignment,
    scratch: string,
  ): Promise<string> {
    const bundlePath = path.join(scratch, "revision.bundle");
    // What this machine already has for this repository. Absent on the first
    // task, and after any repair.
    const held = await git
      .run(["-C", cache, "rev-parse", "--verify", "--quiet", "HEAD"], {
        allowFailure: true,
      })
      .then((result) =>
        result.exitCode === 0 ? result.stdout.trim() : undefined,
      )
      .catch(() => undefined);
    await writeFile(
      bundlePath,
      await this.options.client.bundle(
        assignment.lease.id,
        held !== undefined && /^[0-9a-f]{40}$/u.test(held) ? held : undefined,
      ),
    );
    const absorbed = await git.run(
      [
        "-C",
        cache,
        "fetch",
        "--no-tags",
        "--end-of-options",
        bundlePath,
        `${assignment.bundleRef}:${assignment.bundleRef}`,
      ],
      { allowFailure: true },
    );
    if (absorbed.exitCode !== 0) {
      // Serve this lease from the bundle and start the cache again next time.
      await rm(cache, { recursive: true, force: true }).catch(() => undefined);
      return bundlePath;
    }
    // `HEAD` is what the next task reads to say what it holds, and a bare
    // repository's HEAD points at a branch that does not exist here. Pointing
    // it at the revision just absorbed is what makes the delta possible at
    // all — without it every task would report nothing and fetch everything.
    await git
      .run([
        "-C",
        cache,
        "update-ref",
        "--no-deref",
        "HEAD",
        assignment.bundleRef,
      ])
      .catch(() => undefined);
    return cache;
  }

  /**
   * Fills the workspace with the revision this lease is for.
   *
   * From the cache this is a *local clone*, which hardlinks the object store
   * instead of copying it, and that is the whole of the change: the workspace
   * ends up a complete, ordinary repository whose packs are the same files on
   * disk as the cache's.
   *
   * What it replaces was `init` + `fetch` + `checkout`, and `fetch` is a
   * transfer even when both ends are on the same disk — git resolves what is
   * missing, generates a pack, and writes a second copy of every object the
   * cache already holds. Measured on a 45 MB checkout: 2.95s and 80 MB written
   * per task, against 0.20s and 45 MB. The tenfold gap is on Linux with a warm
   * page cache, which is the friendly case; on Windows the 35 MB it stops
   * writing is 35 MB an antivirus does not read, per task, forever.
   *
   * It is also what the coordinator always did for itself. A server-side run
   * took a worktree off a clone it already held; the worker was the only place
   * paying to rebuild an object store it was standing next to.
   *
   * A worktree of the cache would be faster still and is not used: its `.git`
   * is a *file* pointing outside the workspace, which breaks the moment the
   * workspace is mounted into a container — and the sandbox path does exactly
   * that. A local clone is a real repository wherever it is mounted, and where
   * hardlinks are impossible git copies, which is what happened before anyway.
   *
   * Checked out by revision rather than by ref name: `clone` copies branches
   * and tags, and the lease ref is deliberately neither, so it does not travel.
   * That is the same tidiness the fetch had — the workspace carries no refs of
   * the coordinator's — reached without the transfer.
   */
  private async materialise(
    git: GitClient,
    source: string,
    fromCache: boolean,
    assignment: WorkAssignment,
    workspacePath: string,
  ): Promise<void> {
    if (fromCache) {
      const revision = await git
        .run(["-C", source, "rev-parse", "--verify", "--quiet", assignment.bundleRef], {
          allowFailure: true,
        })
        .then((result) => (result.exitCode === 0 ? result.stdout.trim() : ""))
        .catch(() => "");
      if (/^[0-9a-f]{40}$/u.test(revision)) {
        await git.run(
          [
            "clone",
            "--local",
            "--no-checkout",
            "--no-tags",
            "--end-of-options",
            source,
            workspacePath,
          ],
          { timeoutMs: GIT_COMMAND_TIMEOUT_MS },
        );
        await git.run(
          // No `--end-of-options` here: `checkout` does not accept it in this
          // position, and it would guard nothing anyway — `revision` has just
          // been matched against forty hex characters.
          ["-C", workspacePath, "checkout", "--detach", revision],
          { timeoutMs: GIT_COMMAND_TIMEOUT_MS },
        );
        // `clone` leaves an `origin` pointing at the cache, which the fetch it
        // replaces never did. The objects are already here, so the remote buys
        // nothing and offers something: an agent that decides to `push` or
        // `pull` would be writing into the store every later task reads its
        // delta base from. Removed, so the workspace is what it was before —
        // a detached checkout with nothing to talk to.
        await git
          .run(["-C", workspacePath, "remote", "remove", "origin"], {
            allowFailure: true,
            timeoutMs: GIT_COMMAND_TIMEOUT_MS,
          })
          .catch(() => undefined);
        return;
      }
      // The cache does not hold the ref it just absorbed, which should not
      // happen and is not worth failing a task over. Fall through to the
      // transfer, which asks no questions about what is already there.
    }
    // A bundle, or a cache that could not answer. `clone --branch` cannot name
    // a ref outside `refs/heads/`, and the lease ref deliberately lives under
    // `refs/coord/leases/` so an in-flight lease is not a branch of the
    // canonical repository — so this fetches the ref by its full name and
    // checks out detached, which reaches the same state.
    await git.run(["init", "--end-of-options", workspacePath], {
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    await git.run(
      [
        "-C",
        workspacePath,
        "fetch",
        "--no-tags",
        "--end-of-options",
        source,
        assignment.bundleRef,
      ],
      { timeoutMs: GIT_COMMAND_TIMEOUT_MS },
    );
    await git.run(["-C", workspacePath, "checkout", "--detach", "FETCH_HEAD"], {
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
  }

  /**
   * What this holder has written, for the heartbeat to carry up.
   *
   * Answers nothing at all unless a repository claim is actually held, which
   * is what keeps an ordinary run's heartbeat the call it has always been. A
   * workspace manager that cannot report changes answers nothing too, and a
   * holder that reports nothing is one an arrival cannot freeze — so it waits
   * a retry instead, which is exactly what happens today.
   */
  private async claimedWorkingChanges(
    run: Run,
  ): Promise<readonly WorkingChange[] | undefined> {
    const held = run.claim;
    if (held === undefined) {
      return undefined;
    }
    const list = held.workspaces.listWorkingChanges?.bind(held.workspaces);
    if (list === undefined) {
      return undefined;
    }
    try {
      return (await list(held.workspace)).map((change) => ({
        path: change.path,
        status:
          change.status === "added" || change.status === "deleted"
            ? change.status
            : "modified",
      }));
    } catch {
      return undefined;
    }
  }

  /**
   * Acts on the two things a heartbeat can bring back about a claim.
   *
   * **A narrowed plan.** Somebody arrived and the claim became an ordinary
   * one. The holder is told, because a holder that is not told goes on
   * believing it has the repository and goes on telling its agent so — the
   * same fault the in-process poll exists to prevent, at a distance. Adopting
   * is the same call that accepted the claim in the first place.
   *
   * **An ask.** Somebody is waiting to know what the rest of this work needs,
   * and the answer is what turns their retry into a run. The agent is paused,
   * asked, and resumed by the adapter's own replan; the answer is posted on
   * its own route because it arrives on a model's schedule rather than a
   * heartbeat's.
   *
   * Nothing here may fail the run. A claim that cannot be adopted, an agent
   * that will not answer, a post that does not land — every one of them leaves
   * the claim as it was, which is the recoverable state the freeze is designed
   * around.
   */
  private async answerClaimTraffic(
    run: Run,
    assignment: WorkAssignment,
    reply: HeartbeatReply,
  ): Promise<void> {
    const held = run.claim;
    if (held === undefined) {
      return;
    }
    if (reply.narrowedPlan !== undefined) {
      run.claim = undefined;
      run.adoptedPlan = reply.narrowedPlan;
      await held.adapter
        .acceptBlanketClaim?.(held.sessionId, reply.narrowedPlan)
        .catch(() => undefined);
      await this.options.client
        .progress(
          assignment.lease.id,
          "Another agent arrived, so this run narrowed its claim to the files it is working in.",
        )
        .catch(() => undefined);
      return;
    }
    const askId = reply.declareScope?.askId;
    const claim = held.plan;
    if (
      askId === undefined ||
      held.adapter.requestReplan === undefined ||
      held.adapter.pause === undefined ||
      held.adapter.resume === undefined
    ) {
      return;
    }
    // Paused, asked, resumed — the same three steps the in-process holder
    // takes, for the same reason: what comes back has to be a statement about
    // the rest of this task's work, and an agent mid-tool-call cannot make
    // one. A pause that does not land means no ask, and the claim stays
    // blanket, which is recoverable.
    const paused = await held.adapter
      .pause?.(held.sessionId)
      .then(() => true)
      .catch(() => false);
    if (paused !== true) {
      await this.options.client.postDeclaration(
        assignment.lease.id,
        askId,
        undefined,
        (await this.claimedWorkingChanges(run)) ?? [],
      );
      return;
    }
    const declaration = await held.adapter
      .requestReplan(held.sessionId, {
        taskId: assignment.task.id,
        previousPlan: claim,
        canonicalChange: {
          previousVersion: assignment.canonicalVersion,
          canonicalVersion: assignment.canonicalVersion,
          changedFiles: [],
          changedSymbols: [],
          changedApis: [],
          changedSchemas: [],
          changedConfigKeys: [],
          changedTests: [],
          changedServices: [],
          reason: BLANKET_DECLARATION_REASON,
        },
        constraints: [BLANKET_DECLARATION_REASON],
      })
      .then((plan) =>
        plan.expectedFiles.length > 0 && plan.expectedSymbols.length > 0
          ? { files: [...plan.expectedFiles], symbols: [...plan.expectedSymbols] }
          : undefined,
      )
      .catch(() => undefined);
    // Resumed whatever the answer was. A holder left paused because nobody
    // else needed it is a task that never finishes.
    await held.adapter.resume?.(held.sessionId).catch(() => undefined);
    // The reading is taken *after* the pause, so it is the exact one — the
    // only observation of a remote holder that is not up to a heartbeat old.
    await this.options.client.postDeclaration(
      assignment.lease.id,
      askId,
      declaration,
      (await this.claimedWorkingChanges(run)) ?? [],
    );
  }

  /** Materialises the workspace and gets the agent's plan — no editing yet. */
  private async plan(
    run: Run,
    assignment: WorkAssignment,
    scratch: string,
  ): Promise<PlannedWork> {
    await mkdir(scratch, { recursive: true });
    const git = new GitClient();
    // The repository is kept between tasks rather than fetched again for each.
    //
    // Every lease used to pull the whole reachable history from the control
    // plane — 41 MB for a modest repository — write it, unpack it, and delete
    // it when the task ended, so the next mention paid for all of it again.
    // That is the cost a server-side run never had: the coordinator reads a
    // canonical clone off its own disk. This puts the same thing on the
    // machine that does the work.
    //
    // One run at a time per repository, and only for as long as the cache is
    // being written. Every run fetches into the same bare repository, and
    // concurrently that is not merely slow: git takes a ref lock, the loser's
    // fetch fails, and `updateCache` answers a failed fetch by deleting the
    // cache — out from under the run still reading it. The checkout below is
    // the long part and touches only this run's own workspace, so it is
    // deliberately outside the guard.
    const { cache, source } = await this.serialisedByRepository(
      assignment.repository.id,
      async () => {
        const built = await this.repositoryCache(
          git,
          assignment.repository.id,
        );
        return {
          cache: built,
          source: await this.updateCache(git, built, assignment, scratch),
        };
      },
    );
    // The two halves are timed apart because they fail for opposite reasons: a
    // slow fetch is the network or a cache that keeps being rebuilt, and a slow
    // checkout is the disk — which on Windows usually means a virus scanner
    // reading every file git writes.
    run.laps?.mark("fetch");

    const workspacePath = path.join(scratch, "workspace");
    await this.materialise(git, source, source === cache, assignment, workspacePath);
    run.laps?.mark("checkout");

    const workspace: TaskWorkspace = {
      id: assignment.lease.id,
      taskId: assignment.task.id,
      path: workspacePath,
      rootPath: scratch,
      // The worker has no access to the canonical repository. Only the
      // workspace path and base version are read when collecting a changeset.
      repository: {
        id: assignment.repository.id,
        path: workspacePath,
        branch: assignment.repository.branch,
      },
      baseVersion: assignment.canonicalVersion,
      isolation: "git-worktree",
      createdAt: new Date().toISOString(),
    };

    // Hosted execution runs untrusted agents from different tenants on shared
    // compute, so the worker honours the project's sandbox configuration. With
    // none configured the agent runs unconfined, which is only defensible when
    // the worker itself is single-tenant.
    const worktrees = new GitWorktreeWorkspaceManager(git);
    const sandboxOptions = this.options.project.sandboxOptions();
    const [, configuredAgent] = this.options.project.requireAgent(
      assignment.task.agentId,
    );
    const docker =
      sandboxOptions === undefined
        ? undefined
        : new DockerWorkspaceManager(sandboxOptions, worktrees);
    const agentSandbox =
      sandboxOptions === undefined
        ? undefined
        : new DockerWorkspaceManager(
            {
              ...sandboxOptions,
              ...(configuredAgent.env === undefined
                ? {}
                : { env: configuredAgent.env }),
            },
            worktrees,
          );
    const workspaces: WorkspaceManager = docker ?? worktrees;
    // The lease's MCP servers, after this machine's allowlist. Staged under
    // scratch — the same root the workspace has, so the `finally` that
    // removes the run removes the config and its secrets with it — and
    // staged before the adapter exists, because the adapter is what carries
    // them. Both outcomes are said aloud: a room told nothing sees a run with
    // no tools and cannot tell whether nobody offered any or this machine
    // declined them, and those have different fixes in different places.
    const offered = assignment.mcpServers ?? [];
    const mcp = await stageMcpServers({
      scratch,
      vendor: configuredAgent.adapter ?? "generic-cli",
      servers: offered,
      allow: this.options.project.config.mcp,
    });
    if (offered.length > 0 && mcp.withheld.length > 0) {
      await this.options.client.progress(
        assignment.lease.id,
        `This project offers MCP servers ${mcp.withheld.join(", ")}; this ` +
          "machine has not allowed them (Kumi → Settings on this computer).",
      );
      // Said to the host as well as to the room, because the room cannot
      // fix it. The allowlist belongs to whoever owns this machine, the
      // desktop app is the one thing that can put the question in front of
      // them, and this process read its config once at start — so the most
      // it can do is name what was withheld and let the app ask. Nowhere to
      // send it is the ordinary case and is a no-op.
      signalHost({ type: "mcp-offered", names: mcp.withheld });
    }
    if (mcp.staged.length > 0) {
      await this.options.client.progress(
        assignment.lease.id,
        `Running with tools: ${mcp.staged.join(", ")}.`,
      );
    }
    const adapter = this.adapterFor(
      assignment,
      workspace,
      workspaces,
      agentSandbox,
      mcp,
    );
    // Whatever conversation this request was asked inside travels with it —
    // the hosted path has the same problem the local one does: a follow-up
    // that says "now do the same for the other file" is unanswerable without
    // the messages before it. Handoff seeding is the coordinator's, and the
    // worker does not run one; this is the part the assignment carries.
    // Asked before the session opens, because half of what it answers belongs
    // in the prompt that opens it.
    //
    // Planning is not one inference. It is an agent reading its way into a
    // repository a tool call at a time, and most of that reading is a search
    // for something the control plane has already computed: which files
    // declare the names the objective uses, and where this repository has
    // been working lately. The in-process planner has been handed both for as
    // long as they have existed. A worker was handed neither and started every
    // plan from nothing — the same shape of gap as the missing claim, one
    // layer down.
    const prepared = await this.options.client.claimRepository(
      assignment.lease.id,
    );
    const context = [
      assignment.task.context?.trim() ?? "",
      prepared.planningContext ?? "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const session = await adapter.startTask({
      task: {
        id: assignment.task.id,
        objective: assignment.task.objective,
        agentId: assignment.task.agentId,
        validationCommands: assignment.task.validationCommands,
        ...(context === "" ? {} : { context }),
      },
      canonicalVersion: assignment.canonicalVersion,
      repositoryId: assignment.repository.id,
      ...(context === "" ? {} : { priorContext: context }),
    });
    run.session = { adapter, sessionId: session.id };
    // Listening starts here, not at execution.
    //
    // The full handler in `execute` is attached once a plan has been admitted,
    // which is minutes later: `requestPlan` is allowed ten of them, and it is
    // the phase an agent spends reading the repository and saying what it
    // finds. Nobody was attached for any of it, so the whole planning phase
    // went by in silence and a thread showed the acknowledgement and then
    // nothing — indistinguishable from a hang, and the state most runs are
    // actually in when somebody looks.
    //
    // Progress only. Questions, actions and scope belong to a run that has
    // been admitted, and `execute` answers those with the session's own
    // machinery; forwarding a line of narration needs none of it.
    await adapter
      .streamEvents(session.id, (event) => {
        if (event.event === "progress") {
          void this.options.client.progress(
            assignment.lease.id,
            event.message,
          );
        }
      })
      // An adapter that cannot stream still plans and still works. This is
      // the room's view of the run, never the run itself.
      .catch(() => undefined);
    if (run.cancellationRequested) {
      await this.cancelSession(run);
      throw new LeaseLostError(assignment.lease.id);
    }
    // The adapter separates planning from editing: requestPlan returns the
    // agent's intent without touching the workspace, and nothing is written
    // until sendContext. That split is what makes admission possible at all.
    //
    // A plan already written for this task against this exact base revision is
    // reused rather than bought again. The key pairs the two, so a canonical
    // that has moved cannot match; what is reused is only the model's own
    // output, and it is submitted for admission exactly as a fresh plan would
    // be. See WorkerOptions.planCache.
    const taskId = assignment.task.id;
    const leaseBase = assignment.canonicalVersion.revision;
    const remembered = this.plans.get(taskId);
    let plan: AgentPlan;
    // The whole repository, asked for before it is described.
    //
    // A task alone in its repository is handed all of it and never asked to
    // plan: the plan an agent would write here exists so a second task can
    // arbitrate against it, and where there is no second task the round trip
    // buys nothing. It is the single largest fixed cost before the first edit
    // — an agent round trip, minutes rather than seconds.
    //
    // The in-process coordinator has done this since blanket claims existed.
    // A worker never could: its vocabulary had no claim step, so moving
    // execution onto people's own machines quietly put every desktop task
    // back through planning. This is that step, and the answer is usually no
    // — which costs one cheap call and changes nothing.
    //
    // Asked only where the adapter can be *told* its scope. An agent that can
    // only be asked for a plan has nothing to accept, and granting it a claim
    // it cannot hear about would hold the repository for nobody.
    const acceptClaim = adapter.acceptBlanketClaim?.bind(adapter);
    const claimed = prepared.plan;
    if (claimed !== undefined && acceptClaim !== undefined) {
      await acceptClaim(session.id, claimed);
      run.laps?.mark("claim");
      // Published to the heartbeat, which is the only thing that can report
      // this holder's writes or hear that its claim has been taken back.
      run.claim = {
        adapter,
        sessionId: session.id,
        plan: claimed,
        workspace,
        workspaces,
      };
      // Not remembered in `this.plans`. That cache exists so a task deferred
      // at admission can amend the plan it already paid for rather than buy a
      // second one, and a claim was never bought — a task that comes back
      // here simply asks for the claim again, and is refused if the
      // repository is no longer free.
      return {
        adapter,
        sessionId: session.id,
        plan: claimed,
        workspaceId: workspace.id,
        workspacePath,
      };
    }
    if (remembered !== undefined && remembered.baseRevision === leaseBase) {
      // Same task, same tree: the plan is still exactly what the model would
      // write, so nothing needs asking.
      plan = remembered.plan;
      this.planReuseCount += 1;
    } else if (
      remembered !== undefined &&
      remembered.advancedTo !== undefined &&
      // The notice has to span the *whole* gap: written against the base the
      // remembered plan used, and arriving at the tree this lease pins. A
      // notice covering only part of the distance would understate what
      // moved, and the plan would be amended against a tree it has never
      // been told about — the stale-plan hazard that made blind reuse unsafe.
      remembered.advancedTo.previousVersion.revision ===
        remembered.baseRevision &&
      remembered.advancedTo.canonicalVersion.revision === leaseBase
    ) {
      // Amend rather than rewrite. Measured on `team-queue-wired`, this costs
      // 57% fewer tokens and 49% less wall clock than planning cold, and the
      // amended plan is submitted to exactly the same arbitration.
      plan = await adapter.requestReplan(session.id, {
        taskId,
        previousPlan: remembered.plan,
        canonicalChange: remembered.advancedTo,
        constraints: [],
      });
      this.planAmendCount += 1;
    } else {
      plan = await adapter.requestPlan(session.id);
    }
    // A real model restates the objective in its own words, and the control
    // plane compares objectives byte-for-byte — that comparison is what binds
    // a plan, and later a result, to the leased task, and it must stay
    // strict. So the worker satisfies it by construction: the submitted plan
    // carries the assigned objective, and the model's own phrasing moves to
    // `intent`, which exists precisely to hold prose for advisory analysis.
    const modelObjective = plan.objective.trim();
    const submitted: AgentPlan = {
      ...plan,
      objective: assignment.task.objective,
      ...(plan.intent === undefined &&
      modelObjective.length > 0 &&
      modelObjective !== assignment.task.objective.trim()
        ? { intent: modelObjective }
        : {}),
    };
    // Remembered against the base it was written for, and only once it has
    // been bound to the assigned objective — a plan that failed that binding
    // is not one to hand out again. Any previous notice is dropped: it
    // described a journey this plan has now superseded.
    this.plans.set(taskId, { plan: submitted, baseRevision: leaseBase });
    return {
      adapter,
      sessionId: session.id,
      plan: submitted,
      workspaceId: workspace.id,
      workspacePath,
    };
  }

  /**
   * Runs the agent against the ownership the control plane granted.
   *
   * On a partial admission the grants cover only part of what the agent
   * planned, and the withheld resources arrive as constraints on the decision
   * below — which is how the agent learns about them, since it is given the
   * decision before it edits anything. That is advice, not enforcement: an
   * agent that writes to a deferred file anyway is not stopped here. The
   * control plane splits those patches off the result instead, so the worker
   * never has to make an agent obey a mid-session scope change.
   */
  private async execute(
    run: Run,
    assignment: WorkAssignment,
    planned: PlannedWork,
    admission: PlanAdmission,
  ): Promise<{ plan: AgentPlan; changeSet: ChangeSet }> {
    const { adapter, sessionId, plan } = planned;
    let eventError: unknown;
    let eventChain = Promise.resolve();
    await adapter.streamEvents(sessionId, (event) => {
      eventChain = eventChain
        .then(async () => {
          if (event.event === "progress") {
            // Forwarded so a run on somebody's own machine can say what it is
            // doing. `agent_progress` was emitted only by the in-process
            // coordinator, so a desktop run went from "I've taken this" to its
            // ending with nothing in between — for the whole time the work was
            // actually happening — and read as hung. The post cannot fail the
            // run; see `WorkerClient.progress`.
            await this.options.client.progress(
              assignment.lease.id,
              event.message,
            );
            return;
          }
          if (event.event === "question_asked") {
            // A worker daemon has no channel and nobody watching, so an
            // answer cannot arrive. This event used to be dropped on the
            // floor, which left the adapter's waiter pending and the agent
            // hanging until the execution timeout — an hour of silence for
            // a question nothing could answer. Cancelled at once instead,
            // exactly like the CLI with nobody to ask: the agent stops with
            // its own "no answer" explanation, promptly and legibly.
            await adapter.resolveQuestion?.(sessionId, {
              requestId: event.requestId ?? "",
              status: "cancelled",
            });
            return;
          }
          if (event.event === "action_requested") {
            // Same hazard, same answer. The worker holds no action
            // authority to forward to, and now that the prompt-CLI agents
            // can ask, dropping the event would park their waiter until
            // the execution timeout. Refused immediately, exactly as the
            // coordinator answers when no authority is configured — a
            // refusal is a real answer the agent finishes on.
            await adapter.resolveAction?.(sessionId, {
              requestId: event.requestId ?? "",
              action: event.action,
              outcome: "refused",
              explanation:
                "This worker cannot perform platform actions. Carry on " +
                "within the plan you already have, or report what is " +
                "missing.",
            });
            return;
          }
          if (event.event === "scope_release_requested") {
            // Same hazard as the two above: the adapter blocks on this, so
            // dropping it parks the agent until the execution timeout. The
            // worker holds no ownership of its own — the control plane keeps
            // the leases and the admitted plan — and there is no remote route
            // for a narrowing yet, so it is refused at once. Refusing costs
            // only the early release: the plan the agent already has stays in
            // force, and everything it holds is released at settle as before.
            await adapter.resolveScopeChange(sessionId, {
              requestId: event.requestId ?? "",
              taskId: assignment.task.id,
              decision: "rejected",
              revisedPlan: plan,
              constraints: ["Continue within the admitted plan"],
              ownershipGrants: [],
              explanation:
                "This worker cannot release scope mid-run. Carry on within " +
                "the plan you already have; what you no longer need is " +
                "released when the task settles.",
              decidedAt: new Date().toISOString(),
            });
            return;
          }
          if (event.event !== "scope_change_requested") {
            return;
          }
          await adapter.resolveScopeChange(
            sessionId,
            await this.arbitrateScope(run, assignment, plan, event),
          );
        })
        .catch((error: unknown) => {
          eventError = error;
        });
    });

    // The agent is told what it actually owns, rather than a placeholder
    // approval: these are the grants the control plane issued for this plan.
    const decision: CoordinatorDecision = {
      decision:
        admission.status === "approved" ? "approved" : "approved_with_constraints",
      taskId: assignment.task.id,
      workspaceId: planned.workspaceId,
      planRevision: admission.planRevision,
      ownershipGrants: admission.ownershipGrants,
      constraints: admission.constraints,
      blockedBy: [],
      explanation: admission.explanation,
    };
    await adapter.sendContext(sessionId, {
      decision,
      canonicalVersion: assignment.canonicalVersion,
      workspacePath: planned.workspacePath,
      planRevision: admission.planRevision,
    });
    await eventChain;
    if (eventError !== undefined) {
      throw eventError;
    }
    return {
      plan,
      changeSet: await adapter.collectChanges(sessionId),
    };
  }

  /**
   * Puts a mid-run scope request to the coordinator.
   *
   * The worker holds no view of what other tasks own, so it cannot answer
   * this itself — which is why it used to refuse outright. It forwards
   * instead, and the coordinator arbitrates the widened plan against every
   * other active lease. A temporary deferral is retried here while the agent
   * remains blocked on its request; handing "not yet" back to the model made
   * agents that required the held file report an empty completion.
   *
   * A transport failure is not silently turned into a grant. The agent is
   * told the expansion was not granted and continues inside the scope it
   * already owns, which is the same scope the control plane will hold its
   * changeset to.
   */
  private async arbitrateScope(
    run: Run,
    assignment: WorkAssignment,
    plan: AgentPlan,
    event: Extract<AgentEvent, { event: "scope_change_requested" }>,
  ): Promise<ScopeChangeDecision> {
    const requestId =
      event.requestId?.trim() || `scope_${assignment.task.id}_${Date.now()}`;
    const request: ScopeChangeRequest = {
      id: requestId,
      taskId: assignment.task.id,
      additionalFiles: [...event.additionalFiles],
      additionalSymbols: [...(event.additionalSymbols ?? [])],
      additionalApis: [...(event.additionalApis ?? [])],
      additionalSchemas: [...(event.additionalSchemas ?? [])],
      additionalConfigKeys: [...(event.additionalConfigKeys ?? [])],
      additionalTests: [...(event.additionalTests ?? [])],
      additionalServices: [...(event.additionalServices ?? [])],
      reason: event.reason,
      occurredAt: event.occurredAt,
    };
    try {
      let decision: ScopeChangeDecision;
      do {
        decision = await this.options.client.requestScopeChange(
          assignment.lease.id,
          request,
        );
        if (
          decision.decision === "deferred" &&
          !this.stopping &&
          !run.cancellationRequested
        ) {
          const requested =
            Number.isSafeInteger(decision.retryAfterMs) &&
            (decision.retryAfterMs ?? 0) > 0
              ? decision.retryAfterMs!
              : MIN_PLAN_RETRY_MS;
          await this.waitForAdmissionRetry(
            run,
            Math.max(1, Math.min(MIN_PLAN_RETRY_MS, requested)),
          );
        }
      } while (
        decision.decision === "deferred" &&
        !this.stopping &&
        !run.cancellationRequested
      );
      return decision;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        throw error;
      }
      return {
        requestId,
        taskId: assignment.task.id,
        decision: "rejected",
        revisedPlan: plan,
        constraints: [
          "Remote execution must remain within the admitted plan",
        ],
        ownershipGrants: [],
        explanation:
          "The coordinator could not be reached to arbitrate this expansion: " +
          (error instanceof Error ? error.message : String(error)),
        decidedAt: new Date().toISOString(),
      };
    }
  }

  private adapterFor(
    assignment: WorkAssignment,
    workspace: TaskWorkspace,
    workspaces: WorkspaceManager,
    sandbox: WorkspaceSandbox | undefined,
    mcp: StagedMcpServers,
  ): AgentAdapter {
    const [agentId, agent]: [string, AgentConfig] =
      this.options.project.requireAgent(assignment.task.agentId);
    // The same merge the in-process runner does: what the dispatching channel
    // picked for this agent beats the deployment's configured default, and a
    // remote worker must not quietly run the request at a different model or
    // reasoning depth than the machine next to it would have.
    const args = withModelOverride(agent.args, assignment.task.model);
    const configuredEffort =
      agent.adapter === "claude"
        ? agent.effort
        : undefined;
    const effort = assignment.task.effort ?? configuredEffort;
    const repository = {
      id: assignment.repository.id,
      path: workspace.path,
      branch: assignment.repository.branch,
    };

    if (agent.adapter === "codex") {
      if (sandbox !== undefined) {
        // CodexAdapter confines the agent through Codex's own --sandbox flag,
        // not through a WorkspaceSandbox, so the two cannot be combined yet.
        throw new Error(
          "A container sandbox is configured, but the Codex adapter cannot run " +
            "inside one. Use a generic-cli agent for sandboxed execution, or " +
            "remove the sandbox from this project.",
        );
      }
      const workerExecutionSandbox = codexExecutionSandbox(
        agent.executionSandbox,
      );
      return new CodexAdapter({
        agentId,
        repository: {
          ...repository,
          // A bundle clone is a normal repository. Worktree operations need
          // its actual Git directory, not the working-tree root.
          path: path.join(workspace.path, ".git"),
        },
        workspaces,
        planningRoot: path.join(workspace.rootPath, "planning"),
        ...(agent.command === undefined ? {} : { command: agent.command }),
        ...(args === undefined ? {} : { args }),
        ...(effort === undefined ? {} : { effort }),
        ...(agent.planningTimeoutMs === undefined
          ? {}
          : { planningTimeoutMs: agent.planningTimeoutMs }),
        ...(agent.executionTimeoutMs === undefined
          ? {}
          : { executionTimeoutMs: agent.executionTimeoutMs }),
        ...(agent.windowsSandbox === undefined
          ? {}
          : { windowsSandbox: agent.windowsSandbox }),
        // Same host-decides-the-sandbox rule the in-process runner applies —
        // a remote worker is a different machine again, and the one that runs
        // Codex is the only one that knows whether its sandbox helper exists.
        ...(workerExecutionSandbox === undefined
          ? {}
          : { executionSandbox: workerExecutionSandbox }),
        ...(mcp.codex === undefined ? {} : { mcpServers: mcp.codex.servers }),
        ...(agent.env === undefined ? {} : { env: { ...process.env, ...agent.env } }),
        ...(this.options.codexRunner === undefined
          ? {}
          : { runner: this.options.codexRunner }),
      });
    }
    if (
      agent.adapter === "claude" ||
      agent.adapter === "gemini" ||
      agent.adapter === "cursor" ||
      agent.adapter === "copilot" ||
      agent.adapter === "kiro"
    ) {
      if (sandbox !== undefined) {
        throw new Error(
          `A container sandbox is configured, but ${agent.adapter} agents run ` +
            "the vendor CLI on the worker host with its own login state. Use a " +
            "generic-cli agent for sandboxed execution, or remove the sandbox.",
        );
      }
      if (
        effort !== undefined &&
        !(PROMPT_CLI_EFFORTS as readonly string[]).includes(effort)
      ) {
        throw new Error(
          `Agent "${agentId}" was asked for reasoning effort "${effort}", but ` +
            `${agent.adapter} accepts ${PROMPT_CLI_EFFORTS.join(", ")}`,
        );
      }
      const promptEffort = effort as PromptCliEffort | undefined;
      const create = {
        claude: createClaudeAdapter,
        gemini: createGeminiAdapter,
        cursor: createCursorAdapter,
        copilot: createCopilotAdapter,
        kiro: createKiroAdapter,
      }[agent.adapter];
      return create({
        agentId,
        repository: {
          ...repository,
          // A bundle clone is a normal repository. Worktree operations need
          // its actual Git directory, not the working-tree root.
          path: path.join(workspace.path, ".git"),
        },
        workspaces,
        planningRoot: path.join(workspace.rootPath, "planning"),
        ...(agent.command === undefined ? {} : { command: agent.command }),
        ...(args === undefined ? {} : { args }),
        ...(agent.planningTimeoutMs === undefined
          ? {}
          : { planningTimeoutMs: agent.planningTimeoutMs }),
        ...(agent.executionTimeoutMs === undefined
          ? {}
          : { executionTimeoutMs: agent.executionTimeoutMs }),
        ...(promptEffort === undefined ? {} : { effort: promptEffort }),
        ...(mcp.claude === undefined
          ? {}
          : { mcpConfigPath: mcp.claude.configPath }),
        ...(agent.env === undefined
          ? {}
          : { env: { ...process.env, ...agent.env } }),
      });
    }
    if (agent.command === undefined) {
      throw new Error(
        `Agent "${agentId}" has no command; a generic-cli agent must name an executable`,
      );
    }
    return new GenericCliAdapter({
      agentId,
      launch: {
        command: agent.command,
        args: [...(agent.args ?? [])],
        ...(agent.env === undefined
          ? {}
          : { env: { ...process.env, ...agent.env } }),
      },
      repository,
      workspaces,
      ...(agent.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: agent.executionTimeoutMs }),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
  }

  /**
   * Polls until stopped, keeping as many tasks in flight as this machine said
   * it can hold.
   *
   * The loop takes one lease at a time and starts the next attempt as soon as
   * the previous one *has* a lease rather than when it has finished with it —
   * which is the whole difference from what this used to be. Leases are taken
   * singly and not in a batch on purpose: the repository's parallelism bound
   * is counted across active leases, so asking for four at once would ignore
   * it, and the control plane's own drain takes them one at a time for
   * exactly this reason.
   */
  public async run(): Promise<void> {
    await this.register();
    // Connected after registering, so a nudge can never arrive for a worker
    // the control plane does not yet know about.
    this.options.nudge?.start();
    const idle = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    /** One entry per task in flight; `done` is what prunes it. */
    const slots: Array<{ done: boolean; settled: Promise<void> }> = [];
    // Set by a run the control plane refused rather than executed. A deferred
    // task goes straight back on the queue and this worker is usually the one
    // to pick it up again, so taking it again at once buys the same refusal
    // and a second planning round trip. Read and cleared by the loop.
    let refused = false;
    while (!this.stopping) {
      for (let index = slots.length - 1; index >= 0; index -= 1) {
        if (slots[index]?.done === true) {
          slots.splice(index, 1);
        }
      }
      if (slots.length >= this.concurrency) {
        // Woken by whichever finishes first, so a freed slot is refilled at
        // once rather than at the next tick of the idle timer.
        await Promise.race(slots.map((slot) => slot.settled));
        continue;
      }
      if (refused) {
        refused = false;
        await this.idleWait(idle);
        continue;
      }
      // Resolved with `true` once the attempt holds a lease, and with `false`
      // if it ended without taking one. Waiting on this rather than on the
      // whole attempt is what lets the next lease be taken while this task
      // runs, and waiting on it at all is what stops the loop spinning
      // through lease calls against an empty queue.
      let announce: (leased: boolean) => void = () => undefined;
      const leased = new Promise<boolean>((resolve) => {
        announce = resolve;
      });
      const slot: { done: boolean; settled: Promise<void> } = {
        done: false,
        settled: Promise.resolve(),
      };
      slot.settled = (async () => {
        try {
          const result = await this.runOnce({
            onLeased: () => announce(true),
          });
          if (result.deferred === true) {
            refused = true;
          }
        } catch (error) {
          // A control-plane outage must not kill the daemon, and must not
          // take the tasks running beside this one down with it either.
          process.stderr.write(
            `[worker] poll failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        } finally {
          // A no-op once the lease already announced itself; what it covers
          // is the attempt that never got one.
          announce(false);
          slot.done = true;
        }
      })();
      slots.push(slot);
      if (!(await leased) && !this.stopping) {
        // Nothing queued that this machine can take. The nudge only ever
        // shortens this; with none supplied it is the same fixed backoff the
        // single-task loop always had.
        await this.idleWait(idle);
      }
    }
    // Nothing is abandoned on the way out. `stop` cancels the agents and
    // hands the leases back, and this is what waits for that to finish, so a
    // caller that awaits `run` knows the machine is genuinely quiet.
    await Promise.allSettled(slots.map((slot) => slot.settled));
  }

  /** The wait between polls, cut short by a nudge where one is supplied. */
  private async idleWait(milliseconds: number): Promise<void> {
    await (this.options.nudge?.wait(milliseconds) ??
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /**
   * Cancels the current agent and hands any held lease back.
   *
   * Releasing is what makes a planned shutdown immediate: without it the task
   * would sit unavailable until the lease expired on its own.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    // Released first: it holds a socket and may have a caller parked in
    // `wait`, and neither should outlive the decision to shut down.
    this.options.nudge?.stop();
    // Every one of them, and copied first: `performIteration` removes a run
    // from the set as it ends, and iterating the live set while that happens
    // would skip a task that was still holding a lease.
    const running = [...this.runs];
    await Promise.all(
      running.flatMap((run) => [
        this.cancelSession(run),
        this.options.client.release(run.leaseId).catch(() => undefined),
      ]),
    );
  }

  /**
   * What the running agent says it has spent so far.
   *
   * Empty when the adapter cannot report, which is most of them: reporting is
   * optional throughout, and a coordinator that received nothing records
   * nothing rather than inventing a figure a budget would then be enforced
   * against.
   */
  private spentSoFar(run: Run): AgentTokenUsage[] {
    const active = run.session;
    if (active === undefined) {
      return [];
    }
    try {
      return active.adapter.reportedTokenUsage?.(active.sessionId) ?? [];
    } catch {
      // Accounting must never be able to kill a run.
      return [];
    }
  }

  private cancelSession(run: Run): Promise<void> {
    run.cancellationRequested = true;
    run.admissionWait.abort();
    const active = run.session;
    if (active === undefined) {
      return Promise.resolve();
    }
    run.cancellation ??= active.adapter
      .cancel(active.sessionId)
      .catch(() => undefined);
    return run.cancellation;
  }
}
