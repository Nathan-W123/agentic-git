import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import {
  CodexAdapter,
  type CodexProcessRunner,
} from "@coord/adapter-codex";
import {
  createClaudeAdapter,
  createGeminiAdapter,
} from "@coord/adapter-prompt-cli";
import type {
  AgentAdapter,
  AgentEvent,
  AgentTokenUsage,
} from "@coord/agent-protocol";
import {
  WORKER_PROTOCOL_VERSION,
  type WorkAssignment,
} from "@coord/cli/worker-operations";
import { codexExecutionSandbox } from "@coord/cli/commands";
import type { AgentConfig, CoordinatorProject } from "@coord/cli/project";
import { DEFAULT_PROJECT_ID } from "@coord/persistence";
import { GitClient } from "@coord/repository-service";
import {
  planAdmissionApproved,
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

import { LeaseLostError, WorkerClient, isTransportFailure } from "./client.js";

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
  /** Injected only by tests or embedded runtimes. */
  codexRunner?: CodexProcessRunner;
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
const DEFAULT_PLAN_WAIT_BUDGET_MS = 60_000;
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

export class Worker {
  private identity: { id: string } | undefined;
  /** See {@link WorkerOptions.planCache}. Per-worker unless one is injected. */
  private readonly plans: Map<string, CachedPlan>;
  /** Reused plans this worker did not have to buy again. */
  public planReuseCount = 0;
  /** Plans amended from a previous one rather than written from nothing. */
  public planAmendCount = 0;
  private stopping = false;
  private activeLease: string | undefined;
  private activeSession:
    | { adapter: AgentAdapter; sessionId: string }
    | undefined;
  private activeCancellation: Promise<void> | undefined;
  private cancellationRequested = false;
  private admissionWait: AbortController | undefined;
  private iterationInProgress = false;

  public constructor(private readonly options: WorkerOptions) {
    this.plans = options.planCache ?? new Map<string, CachedPlan>();
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
    const adapters = [
      ...new Set(
        Object.values(this.options.project.config.agents).map((agent) =>
          agent.adapter ?? "generic-cli",
        ),
      ),
    ];
    const identity = await this.options.client.register({
      organizationId: this.options.organizationId,
      name: this.options.name ?? `worker-${process.pid}`,
      adapters,
      version: this.options.version ?? "0.0.0",
    });
    this.identity = identity;
    return identity.id;
  }

  /**
   * Performs at most one unit of work.
   *
   * Separated from {@link run} so the whole cycle can be driven directly by a
   * test without an infinite loop.
   */
  public async runOnce(): Promise<IterationResult> {
    if (this.stopping) {
      return { worked: false };
    }
    if (this.iterationInProgress) {
      throw new Error("A worker iteration is already in progress");
    }
    this.iterationInProgress = true;
    try {
      return await this.performIteration();
    } finally {
      this.iterationInProgress = false;
    }
  }

  private async performIteration(): Promise<IterationResult> {
    const workerId = this.identity?.id ?? (await this.register());
    const assignment = await this.options.client.lease(
      workerId,
      this.options.projectId ?? DEFAULT_PROJECT_ID,
      this.options.repositoryId,
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

    this.activeLease = assignment.lease.id;
    this.activeSession = undefined;
    this.activeCancellation = undefined;
    this.cancellationRequested = false;
    this.admissionWait = new AbortController();
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
      heartbeat = this.options.client
        .heartbeat(assignment.lease.id, this.spentSoFar())
        .catch(async (error) => {
          if (error instanceof LeaseLostError) {
            leaseLost = true;
            await this.cancelActiveSession();
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

      const planned = await this.plan(assignment, scratch);
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const admission = await this.awaitAdmission(assignment, planned.plan);
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

      const result = await this.execute(assignment, planned, admission);
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const accepted = await this.options.client.report(
        assignment.lease.id,
        {
          status: "completed",
          plan: result.plan,
          changeSet: result.changeSet,
        },
        this.spentSoFar(),
      );
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
      await heartbeat?.catch(() => undefined);
      await this.cancelActiveSession();
      this.activeLease = undefined;
      this.activeSession = undefined;
      this.activeCancellation = undefined;
      this.admissionWait = undefined;
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
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
      !this.cancellationRequested &&
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
      await this.waitForAdmissionRetry(wait);
      if (this.stopping || this.cancellationRequested) {
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

  private async waitForAdmissionRetry(milliseconds: number): Promise<void> {
    const signal = this.admissionWait?.signal;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      function finish(): void {
        signal?.removeEventListener("abort", finish);
        clearTimeout(timer);
        resolve();
      }
      if (signal?.aborted === true) {
        finish();
      } else {
        signal?.addEventListener("abort", finish, { once: true });
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

  /** Materialises the workspace and gets the agent's plan — no editing yet. */
  private async plan(
    assignment: WorkAssignment,
    scratch: string,
  ): Promise<PlannedWork> {
    await mkdir(scratch, { recursive: true });
    const bundlePath = path.join(scratch, "revision.bundle");
    await writeFile(bundlePath, await this.options.client.bundle(assignment.lease.id));

    const workspacePath = path.join(scratch, "workspace");
    const git = new GitClient();
    // `clone --branch` cannot name a ref outside `refs/heads/`, and the lease
    // ref deliberately lives under `refs/coord/leases/` so an in-flight lease
    // is not a branch of the canonical repository. Fetching the ref by its
    // full name and checking out detached reaches the same state and is
    // tidier about it: the workspace ends up carrying no refs at all, where a
    // clone left the lease ref and a remote-tracking copy of it behind.
    await git.run(["init", "--end-of-options", workspacePath]);
    await git.run([
      "-C",
      workspacePath,
      "fetch",
      "--no-tags",
      "--end-of-options",
      bundlePath,
      assignment.bundleRef,
    ]);
    await git.run([
      "-C",
      workspacePath,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);

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
    const adapter = this.adapterFor(
      assignment,
      workspace,
      workspaces,
      agentSandbox,
    );
    const session = await adapter.startTask({
      task: {
        id: assignment.task.id,
        objective: assignment.task.objective,
        agentId: assignment.task.agentId,
        validationCommands: assignment.task.validationCommands,
      },
      canonicalVersion: assignment.canonicalVersion,
      repositoryId: assignment.repository.id,
    });
    this.activeSession = { adapter, sessionId: session.id };
    if (this.cancellationRequested) {
      await this.cancelActiveSession();
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
          if (event.event !== "scope_change_requested") {
            return;
          }
          await adapter.resolveScopeChange(
            sessionId,
            await this.arbitrateScope(assignment, plan, event),
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
   * other active lease and answers grant, defer, or refuse.
   *
   * A transport failure is not silently turned into a grant. The agent is
   * told the expansion was not granted and continues inside the scope it
   * already owns, which is the same scope the control plane will hold its
   * changeset to.
   */
  private async arbitrateScope(
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
      return await this.options.client.requestScopeChange(
        assignment.lease.id,
        request,
      );
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
  ): AgentAdapter {
    const [agentId, agent]: [string, AgentConfig] =
      this.options.project.requireAgent(assignment.task.agentId);
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
        ...(agent.args === undefined ? {} : { args: agent.args }),
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
        ...(agent.env === undefined ? {} : { env: { ...process.env, ...agent.env } }),
        ...(this.options.codexRunner === undefined
          ? {}
          : { runner: this.options.codexRunner }),
      });
    }
    if (agent.adapter === "claude" || agent.adapter === "gemini") {
      if (sandbox !== undefined) {
        throw new Error(
          `A container sandbox is configured, but ${agent.adapter} agents run ` +
            "the vendor CLI on the worker host with its own login state. Use a " +
            "generic-cli agent for sandboxed execution, or remove the sandbox.",
        );
      }
      const create =
        agent.adapter === "claude" ? createClaudeAdapter : createGeminiAdapter;
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
        ...(agent.args === undefined ? {} : { args: agent.args }),
        ...(agent.planningTimeoutMs === undefined
          ? {}
          : { planningTimeoutMs: agent.planningTimeoutMs }),
        ...(agent.executionTimeoutMs === undefined
          ? {}
          : { executionTimeoutMs: agent.executionTimeoutMs }),
        ...(agent.effort === undefined ? {} : { effort: agent.effort }),
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

  /** Polls until stopped. */
  public async run(): Promise<void> {
    await this.register();
    const idle = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    while (!this.stopping) {
      let result: IterationResult;
      try {
        result = await this.runOnce();
      } catch (error) {
        // A control-plane outage must not kill the daemon; back off and retry.
        process.stderr.write(
          `[worker] poll failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        result = { worked: false };
      }
      // A deferred task goes straight back to the queue, and this worker is
      // usually the one that picks it up again. Polling immediately would
      // replan it into the same refusal, so back off as if the queue were
      // empty — which, for work this worker can do, it effectively is.
      if ((!result.worked || result.deferred === true) && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, idle));
      }
    }
  }

  /**
   * Cancels the current agent and hands any held lease back.
   *
   * Releasing is what makes a planned shutdown immediate: without it the task
   * would sit unavailable until the lease expired on its own.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    const lease = this.activeLease;
    await Promise.all([
      this.cancelActiveSession(),
      lease === undefined
        ? Promise.resolve()
        : this.options.client.release(lease).catch(() => undefined),
    ]);
  }

  /**
   * What the running agent says it has spent so far.
   *
   * Empty when the adapter cannot report, which is most of them: reporting is
   * optional throughout, and a coordinator that received nothing records
   * nothing rather than inventing a figure a budget would then be enforced
   * against.
   */
  private spentSoFar(): AgentTokenUsage[] {
    const active = this.activeSession;
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

  private cancelActiveSession(): Promise<void> {
    this.cancellationRequested = true;
    this.admissionWait?.abort();
    const active = this.activeSession;
    if (active === undefined) {
      return Promise.resolve();
    }
    this.activeCancellation ??= active.adapter
      .cancel(active.sessionId)
      .catch(() => undefined);
    return this.activeCancellation;
  }
}
