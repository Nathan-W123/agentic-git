import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GenericCliAdapter } from "@coord/adapter-generic-cli";
import { CodexAdapter } from "@coord/adapter-codex";
import type { AgentAdapter } from "@coord/agent-protocol";
import type { WorkAssignment } from "@coord/cli/worker-operations";
import type { AgentConfig, CoordinatorProject } from "@coord/cli/project";
import { GitClient } from "@coord/repository-service";
import type { ChangeSet } from "@coord/shared-types";
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
 * workspace from a bundle, runs the agent, returns a changeset, and deletes
 * everything. If it dies at any point the lease lapses and the control plane
 * hands the task to someone else.
 */

export interface WorkerOptions {
  client: WorkerClient;
  project: CoordinatorProject;
  workspaceRoot: string;
  name?: string;
  version?: string;
  repositoryId?: string;
  /** Idle wait between polls when the queue is empty. */
  pollIntervalMs?: number;
}

export interface IterationResult {
  worked: boolean;
  taskId?: string;
  accepted?: boolean;
  reason?: string;
}

const DEFAULT_POLL_MS = 5_000;

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
      const changeSet = await this.execute(assignment, scratch);
      if (leaseLost) {
        throw new LeaseLostError(assignment.lease.id);
      }
      const accepted = await this.options.client.report(assignment.lease.id, {
        status: "completed",
        changeSet,
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

  /** Materialises the workspace, runs the agent, and collects the diff. */
  private async execute(
    assignment: WorkAssignment,
    scratch: string,
  ): Promise<ChangeSet> {
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
    const docker =
      sandboxOptions === undefined
        ? undefined
        : new DockerWorkspaceManager(sandboxOptions, worktrees);
    const workspaces: WorkspaceManager = docker ?? worktrees;
    const adapter = this.adapterFor(assignment, workspace, workspaces, docker);
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
    await adapter.requestPlan(session.id);
    await adapter.sendContext(session.id, {
      decision: {
        decision: "approved",
        taskId: assignment.task.id,
        workspaceId: workspace.id,
        ownershipGrants: [],
        constraints: [],
        blockedBy: [],
        explanation: "Leased to a remote worker",
      },
      canonicalVersion: assignment.canonicalVersion,
      workspacePath,
    });
    return await adapter.collectChanges(session.id);
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
        repository,
        workspaces,
        planningRoot: path.join(workspace.rootPath, "planning"),
        ...(agent.command === undefined ? {} : { command: agent.command }),
        ...(agent.env === undefined ? {} : { env: { ...process.env, ...agent.env } }),
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
      if (!result.worked && !this.stopping) {
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
