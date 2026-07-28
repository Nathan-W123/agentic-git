import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { CoordinationStore } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";

import type { CoordinatorProject } from "./project.js";

/**
 * Crash recovery for the control plane.
 *
 * A crash leaves three kinds of debris: runs stuck in `running`, claimed
 * tasks whose claiming process no longer exists, and worktree scratch
 * directories nothing will ever read again. Recovery runs once at startup —
 * before the process serves anything — so everything it finds is genuinely
 * orphaned: in-process work cannot exist yet, and remote workers are
 * deliberately left alone because their leases are their liveness signal.
 *
 * Recovery must only run where it is the sole control plane for the store
 * (the documented deployment shape). A second instance recovering a live
 * one's state would cancel in-flight runs.
 */

export interface RecoveryReport {
  /** Runs that were stuck in `running` and are now failed. */
  failedRuns: string[];
  /** Claimed tasks with no active lease, returned to the queue. */
  requeuedTasks: string[];
  /** Active leases past their expiry, lapsed (their tasks requeue). */
  expiredLeases: string[];
  /** Scratch directories removed from the workspace/planning/integration roots. */
  removedDirectories: string[];
  /** Canonical mirrors whose stale worktree registrations were pruned. */
  prunedRepositories: string[];
  /** Non-fatal problems, e.g. a directory that could not be deleted. */
  warnings: string[];
}

const TERMINAL_TASK_STATUSES = new Set(["integrated", "failed", "cancelled"]);

async function clearScratchRoot(
  root: string,
  report: RecoveryReport,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // The root does not exist yet; nothing to clean.
  }
  for (const entry of entries) {
    const target = path.join(root, entry);
    try {
      await rm(target, { recursive: true, force: true });
      report.removedDirectories.push(target);
    } catch (error) {
      report.warnings.push(
        `Could not remove ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Fails stranded runs, requeues stranded claims, and clears orphaned
 * worktrees. Idempotent; a clean store and tree produce an empty report.
 */
export async function recoverCoordinationState(
  project: CoordinatorProject,
  store: CoordinationStore,
  repositories = new RepositoryService(),
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    failedRuns: [],
    requeuedTasks: [],
    expiredLeases: [],
    removedDirectories: [],
    prunedRepositories: [],
    warnings: [],
  };
  const now = new Date().toISOString();

  // Leases past expiry lapse now instead of at the next poll; their tasks
  // return to the queue. Unexpired active leases belong to live remote
  // workers and are not touched.
  for (const lease of await store.expireWorkLeases(now)) {
    report.expiredLeases.push(lease.id);
  }

  // A claimed task with no active lease was claimed by a process that no
  // longer exists — the in-process path never survives a restart. Requeue it
  // so the queue simply runs it again: this is what makes recovery automatic
  // rather than "retry it manually".
  const activeLeases = await store.listWorkLeases({ status: "active" });
  const leasedTasks = new Set(activeLeases.map((lease) => lease.taskId));
  for (const task of await store.listSubmittedTasks({ status: "claimed" })) {
    if (leasedTasks.has(task.id)) {
      continue;
    }
    await store.retrySubmittedTask(task.id);
    report.requeuedTasks.push(task.id);
  }

  // A run still `running` at boot died with its process. Its non-terminal
  // tasks are failed with an explanation rather than left in a phantom
  // in-progress state, and the run itself is closed as failed.
  for (const run of await store.listRuns(500)) {
    if (run.status !== "running") {
      continue;
    }
    const detail = await store.getRun(run.id);
    for (const task of detail?.tasks ?? []) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        continue;
      }
      await store.saveTaskStatus(
        run.id,
        task.id,
        "failed",
        "The control plane restarted while this task was in flight",
      );
      await store.appendAudit(run.id, {
        type: "task_failed",
        taskId: task.id,
        data: {
          stage: "crash_recovery",
          explanation:
            "The control plane restarted while this task was in flight",
        },
      });
    }
    await store.finishRun(run.id, "failed");
    report.failedRuns.push(run.id);
  }

  // Worktree garbage collection. Recovery runs before anything is in
  // flight, so every scratch directory is an orphan by definition.
  await clearScratchRoot(project.workspaceRoot, report);
  await clearScratchRoot(project.planningRoot, report);
  await clearScratchRoot(project.integrationRoot, report);

  // The mirrors still hold registrations for the worktrees just deleted;
  // prune them so future `git worktree add` calls cannot collide.
  const git = repositories.getGitClient();
  for (const repository of await store.listRepositories()) {
    try {
      await git.run(["-C", repository.path, "worktree", "prune"]);
      report.prunedRepositories.push(repository.id);
    } catch (error) {
      report.warnings.push(
        `Could not prune worktrees of ${repository.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const eventful =
    report.failedRuns.length > 0 ||
    report.requeuedTasks.length > 0 ||
    report.expiredLeases.length > 0;
  if (eventful) {
    await store.appendAudit(undefined, {
      type: "recovery_completed",
      data: {
        failedRuns: report.failedRuns,
        requeuedTasks: report.requeuedTasks,
        expiredLeases: report.expiredLeases,
        removedDirectories: report.removedDirectories.length,
        prunedRepositories: report.prunedRepositories.length,
        warnings: report.warnings,
      },
    });
  }
  return report;
}
