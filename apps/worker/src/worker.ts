import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import {
  CodexAdapter,
  type CodexProcessRunner,
} from "@coord/adapter-codex";
import type { AgentAdapter } from "@coord/agent-protocol";
import {
  WORKER_PROTOCOL_VERSION,
  type WorkAssignment,
} from "@coord/cli/worker-operations";
import type { AgentConfig, CoordinatorProject } from "@coord/cli/project";
import { DEFAULT_PROJECT_ID } from "@coord/persistence";
import { GitClient } from "@coord/repository-service";
import {
  planAdmissionApproved,
  type AgentPlan,
  type ChangeSet,
  type CoordinatorDecision,
  type PlanAdmission,
  type ScopeChangeDecision,
} from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
  type WorkspaceSandbox,
} from "@coord/workspace-manager";

import { LeaseLostError, WorkerClient } from "./client.js";

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

export interface WorkerOptions {
  client: WorkerClient;
  project: CoordinatorProject;
  workspaceRoot: string;
  name?: string;
  version?: string;
  projectId?: string;
  repositoryId?: string;
  /** Injected only by tests or embedded runtimes. */
  codexRunner?: CodexProcessRunner;
  /** Idle wait between polls when the queue is empty. */
  pollIntervalMs?: number;
  /**
   * How long to keep resubmitting a deferred plan before handing the lease
   * back. Waiting keeps the already-paid planning work; giving up keeps a
   * repository slot from being held by a task that cannot start.
   */
  planWaitBudgetMs?: number;
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
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_PLAN_WAIT_BUDGET_MS = 60_000;
const MIN_PLAN_RETRY_MS = 1_000;

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
  private stopping = false;
  private activeLease: string | undefined;

  public constructor(private readonly options: WorkerOptions) {}

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
    const workerId = this.identity?.id ?? (await this.register());
    const assignment = await this.options.client.lease(
      workerId,
      this.options.projectId ?? DEFAULT_PROJECT_ID,
      this.options.repositoryId,
    );
    if (assignment === undefined) {
      return { worked: false };
    }

    this.activeLease = assignment.lease.id;
    const scratch = path.join(
      this.options.workspaceRoot,
      assignment.lease.id.replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(-12),
    );

    // Heartbeat runs alongside execution: an agent can take many minutes, far
    // longer than the lease, so without this the control plane would reclaim a
    // task that is still being worked on.
    let leaseLost = false;
    const beat = setInterval(() => {
      void this.options.client.heartbeat(assignment.lease.id).catch((error) => {
        if (error instanceof LeaseLostError) {
          leaseLost = true;
        }
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
      const admission = await this.awaitAdmission(assignment, planned.plan);
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      if (!planAdmissionApproved(admission)) {
        return await this.defer(assignment, planned, admission);
      }

      const result = await this.execute(assignment, planned, admission);
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const accepted = await this.options.client.report(assignment.lease.id, {
        status: "completed",
        plan: result.plan,
        changeSet: result.changeSet,
      });
      return {
        worked: true,
        taskId: assignment.task.id,
        accepted: accepted.accepted,
        ...(accepted.reason === undefined ? {} : { reason: accepted.reason }),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof LeaseLostError) {
        // The task belongs to someone else now; reporting would be a lie.
        return { worked: true, taskId: assignment.task.id, accepted: false, reason: detail };
      }
      await this.options.client
        .report(assignment.lease.id, { status: "failed", detail: detail.slice(0, 2000) })
        .catch(() => undefined);
      return { worked: true, taskId: assignment.task.id, accepted: false, reason: detail };
    } finally {
      clearInterval(beat);
      this.activeLease = undefined;
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
    const deadline = Date.now() + budget;
    let admission = await this.options.client.submitPlan(
      assignment.lease.id,
      plan,
    );
    while (
      !planAdmissionApproved(admission) &&
      // A requeue means canonical moved: the same plan can never be admitted
      // again, so waiting would be pointless.
      admission.requeue !== true &&
      !this.stopping &&
      Date.now() < deadline
    ) {
      const wait = Math.max(
        MIN_PLAN_RETRY_MS,
        admission.retryAfterMs ?? MIN_PLAN_RETRY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.stopping) {
        break;
      }
      admission = await this.options.client.submitPlan(
        assignment.lease.id,
        plan,
      );
    }
    return admission;
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
    await git.run([
      "clone",
      "--branch",
      assignment.bundleRef,
      "--end-of-options",
      bundlePath,
      workspacePath,
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
    // The adapter separates planning from editing: requestPlan returns the
    // agent's intent without touching the workspace, and nothing is written
    // until sendContext. That split is what makes admission possible at all.
    const plan = await adapter.requestPlan(session.id);
    return {
      adapter,
      sessionId: session.id,
      plan,
      workspaceId: workspace.id,
      workspacePath,
    };
  }

  /** Runs the agent against the ownership the control plane granted. */
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
          const decision: ScopeChangeDecision = {
            requestId:
              event.requestId?.trim() ||
              `scope_${assignment.task.id}_${Date.now()}`,
            taskId: assignment.task.id,
            decision: "rejected",
            revisedPlan: plan,
            constraints: [
              "Remote execution must remain within the admitted plan",
            ],
            ownershipGrants: [],
            explanation:
              "Scope expansion was never arbitrated; it requires a new plan " +
              "admission and lease",
            decidedAt: new Date().toISOString(),
          };
          await adapter.resolveScopeChange(sessionId, decision);
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

    if ((agent.adapter ?? "generic-cli") === "codex") {
      if (sandbox !== undefined) {
        // CodexAdapter confines the agent through Codex's own --sandbox flag,
        // not through a WorkspaceSandbox, so the two cannot be combined yet.
        throw new Error(
          "A container sandbox is configured, but the Codex adapter cannot run " +
            "inside one. Use a generic-cli agent for sandboxed execution, or " +
            "remove the sandbox from this project.",
        );
      }
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
        ...(agent.env === undefined ? {} : { env: { ...process.env, ...agent.env } }),
        ...(this.options.codexRunner === undefined
          ? {}
          : { runner: this.options.codexRunner }),
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
   * Stops after the current task and hands any held lease back.
   *
   * Releasing is what makes a planned shutdown immediate: without it the task
   * would sit unavailable until the lease expired on its own.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    const lease = this.activeLease;
    if (lease !== undefined) {
      await this.options.client.release(lease).catch(() => undefined);
    }
  }
}
