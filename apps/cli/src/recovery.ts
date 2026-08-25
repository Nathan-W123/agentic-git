import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { IntegrationService } from "@coord/integration-service";
import type {
  CoordinationStore,
  RunDetail,
  SubmittedTask,
} from "@coord/persistence";
import {
  agentCommitIdentity,
  RepositoryService,
} from "@coord/repository-service";
import type { ChangeSet } from "@coord/shared-types";
import {
  DockerWorkspaceManager,
  GitWorktreeWorkspaceManager,
  type WorkspaceManager,
} from "@coord/workspace-manager";

import { releaseLocalRunnerLeases } from "./commands.js";
import type { CoordinatorProject } from "./project.js";
import { bundleRefFor } from "./worker-operations.js";

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
 * One part of it does not stay at startup. {@link reapStrandedWork} is also a
 * sweep a serving process repeats, because a task can be abandoned long after
 * boot — and {@link drainInFlightWork} is its opposite number, run on the way
 * out so a planned restart hands its work back instead of leaving it to be
 * discovered.
 *
 * Recovery must only run where it is the sole control plane for the store
 * (the documented deployment shape). A second instance recovering a live
 * one's state would cancel in-flight runs.
 *
 * ## What resumes and what restarts
 *
 * An agent session cannot be resumed. Agents are stateless child processes
 * whose reasoning lives in their own memory and whose edits live in a
 * workspace the crash orphaned; nothing durable describes where one had got
 * to, so a task killed while its agent was thinking genuinely has to be run
 * again. That is a property of the agent contract, not a missing feature.
 *
 * The pipeline behind the agent is a different matter, and it does resume.
 * A changeset is written to the store the moment it is collected, before
 * anything is validated or promoted, so a crash in the window between
 * collection and promotion leaves a complete, durable description of the work
 * on disk. Recovery integrates it — validating and promoting exactly as the
 * normal path would — instead of throwing away a finished agent run and
 * paying for it a second time. Everything that makes an integration safe is
 * unchanged: the patches are applied three-way onto current canonical, the
 * applied set is compared against the declared set, validation must pass, and
 * promotion is still compare-and-swap.
 */

export interface RecoveryReport {
  /** Runs that were stuck in `running` and are now failed. */
  failedRuns: string[];
  /**
   * Tasks whose durable changeset was integrated instead of being re-run.
   * These are the crash-window results the previous process had collected but
   * not yet promoted.
   */
  resumedTasks: string[];
  /** Claimed tasks with no active lease, returned to the queue. */
  requeuedTasks: string[];
  /** Active leases past their expiry, lapsed (their tasks requeue). */
  expiredLeases: string[];
  /** Scratch directories removed from the workspace/planning/integration roots. */
  removedDirectories: string[];
  /** Canonical mirrors whose stale worktree registrations were pruned. */
  prunedRepositories: string[];
  /**
   * Lease refs deleted because no active lease owned them.
   *
   * `createBundle` removes its ref in a `finally`, which a killed process
   * never reaches. Each survivor pins its objects against `gc` and makes that
   * lease impossible to bundle again, since bundling refuses to overwrite an
   * existing ref.
   */
  removedLeaseRefs: string[];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The last changeset a run durably recorded for one task, if it was never
 * integrated.
 *
 * "Never integrated" is decided from the integration records rather than from
 * task status, because status is exactly what a crash leaves unreliable. An
 * integration keyed to this changeset means the previous process got far
 * enough to record an outcome, and re-applying it would republish work that
 * has already been decided.
 */
function resumableChangeSet(
  detail: RunDetail,
  taskId: string,
): ChangeSet | undefined {
  const decided = new Set(
    detail.integrations.map((integration) => integration.changeSetId),
  );
  return detail.changeSets
    .filter(
      (changeSet) =>
        changeSet.taskId === taskId && !decided.has(changeSet.id),
    )
    .at(-1);
}

/**
 * Integrates the changesets a crash stranded between collection and promotion.
 *
 * Runs before the requeue and fail passes so those see the settled state: a
 * task whose work was promoted here must not also be handed back to the queue
 * for an agent to redo.
 *
 * Validation is a repository's own commands, so it runs through the project's
 * configured sandbox for the same reason the ordinary integration path does —
 * recovery is not a licence to execute repository code unconfined.
 */
async function resumeStrandedResults(
  project: CoordinatorProject,
  store: CoordinationStore,
  repositories: RepositoryService,
  report: RecoveryReport,
): Promise<void> {
  const runs = (await store.listRuns(500)).filter(
    (run) => run.status === "running",
  );
  if (runs.length === 0) {
    return;
  }

  const sandboxOptions = project.sandboxOptions();
  const worktrees = new GitWorktreeWorkspaceManager(
    repositories.getGitClient(),
  );
  const workspaces: WorkspaceManager =
    sandboxOptions === undefined
      ? worktrees
      : new DockerWorkspaceManager(sandboxOptions, worktrees);
  const integrations = new IntegrationService(repositories, workspaces);

  for (const run of runs) {
    const detail = await store.getRun(run.id);
    if (detail === undefined) {
      continue;
    }
    const stored = await store.getRepository(run.repositoryId);
    if (stored === undefined) {
      continue;
    }
    const repository = {
      id: stored.id,
      path: stored.path,
      branch: stored.branch,
    };

    for (const task of detail.tasks) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        continue;
      }
      const changeSet = resumableChangeSet(detail, task.id);
      if (changeSet === undefined) {
        continue;
      }

      try {
        await mkdir(project.integrationRoot, { recursive: true });
        const integration = await integrations.integrate({
          repository,
          integrationRoot: project.integrationRoot,
          changeSet,
          validationCommands: task.validationCommands,
          commitMessage: `coord(${task.id}): ${task.objective}`,
          author: agentCommitIdentity(task.agentId),
          trailers: [
            { key: "Agent", value: task.agentId },
            // The agent's work, promoted by a later process than the one that
            // collected it. Worth saying, since the commit's timestamp will
            // sit well after the run it belongs to.
            { key: "Resumed-By", value: "crash-recovery" },
          ],
        });
        await store.saveIntegration(run.id, integration);
        if (integration.status !== "integrated") {
          // Not resumed. The task falls through to the ordinary failure path
          // with a reason that says what was tried, which is better than a
          // bare "the control plane restarted".
          report.warnings.push(
            `Could not resume ${task.id} from its recorded changeset ` +
              `(${integration.status}): ${integration.explanation}`,
          );
          continue;
        }
        await store.saveTaskStatus(
          run.id,
          task.id,
          "integrated",
          `${integration.explanation}; resumed from the changeset recorded ` +
            "before the control plane restarted",
        );
        const submitted = (await store.listSubmittedTasks()).find(
          (entry) => entry.id === task.id,
        );
        if (submitted !== undefined && submitted.status === "claimed") {
          await store.completeSubmittedTask(task.id, "integrated", run.id);
        } else if (submitted !== undefined && submitted.status === "submitted") {
          // Back in the queue, because the process that was running it handed
          // its lease back on the way out. Its work has just been promoted, so
          // running it again would spend an agent redoing what is already in
          // canonical. A row can only be completed from `claimed`, so it is
          // claimed back first — and `claimSubmittedTasks` takes the whole
          // queue for that repository, so everything else it caught is handed
          // straight back.
          const alsoClaimed = await store.claimSubmittedTasks(
            submitted.repositoryId,
            submitted.projectId,
          );
          await store.completeSubmittedTask(task.id, "integrated", run.id);
          for (const other of alsoClaimed) {
            if (other.id === task.id) {
              continue;
            }
            await store.retrySubmittedTask(other.id).catch(() => undefined);
          }
        }
        await store.appendAudit(run.id, {
          type: "canonical_promoted",
          taskId: task.id,
          data: {
            stage: "crash_recovery",
            // Same reason the coordinator stamps it: an advance without a
            // repository is one the auditor cannot place, and it skips those
            // silently. Work recovered after a crash is exactly the work most
            // worth a second pair of eyes.
            repositoryId: repository.id,
            previousRevision: integration.previousVersion.revision,
            revision: integration.canonicalVersion.revision,
            changeSetId: integration.changeSetId,
            explanation:
              "The agent had finished and its changeset was durable; " +
              "recovery integrated it rather than re-running the task",
          },
        });
        report.resumedTasks.push(task.id);
      } catch (error) {
        report.warnings.push(
          `Could not resume ${task.id}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

/**
 * Resumes durable results, fails what is left stranded, requeues stranded
 * claims, and clears orphaned worktrees. Idempotent; a clean store and tree
 * produce an empty report.
 */
export async function recoverCoordinationState(
  project: CoordinatorProject,
  store: CoordinationStore,
  repositories = new RepositoryService(),
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    failedRuns: [],
    resumedTasks: [],
    requeuedTasks: [],
    expiredLeases: [],
    removedDirectories: [],
    prunedRepositories: [],
    removedLeaseRefs: [],
    warnings: [],
  };
  const now = new Date().toISOString();

  // Leases past expiry lapse now instead of at the next poll; their tasks
  // return to the queue. Unexpired active leases belong to live remote
  // workers and are not touched.
  for (const lease of await store.expireWorkLeases(now)) {
    report.expiredLeases.push(lease.id);
  }

  // Worktree garbage collection comes first now, because resumption below
  // builds an integration worktree of its own and must not inherit whatever
  // the crash left in these roots.
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

  // Lease refs are the other thing a killed process leaves in a mirror.
  // Expiry above has already settled which leases are still live, so a ref
  // with no active lease behind it is debris — and debris that costs
  // something, since it holds its objects against `gc` and makes its own
  // lease unbundlable for as long as it survives.
  //
  // Live leases are read once rather than per repository: a remote worker
  // still holding one is mid-execution and its ref must stay.
  const liveLeaseRefs = new Set(
    (await store.listWorkLeases({ status: "active" })).map((lease) =>
      bundleRefFor(lease.id),
    ),
  );
  for (const repository of await store.listRepositories()) {
    try {
      // Mirrors imported before reflogs were turned on would otherwise stay
      // without one forever. Setting a value already set costs nothing.
      await repositories.ensureReflog(repository);
      for (const reference of await repositories.listLeaseRefs(repository)) {
        if (liveLeaseRefs.has(reference)) {
          continue;
        }
        await repositories.deleteLeaseRef(repository, reference);
        report.removedLeaseRefs.push(reference);
      }
    } catch (error) {
      report.warnings.push(
        `Could not sweep lease refs of ${repository.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Work the crash interrupted after the agent finished. The changeset is on
  // disk, so this is a resumption rather than a restart: the task is carried
  // the rest of the way through validation and promotion instead of being
  // failed and planned again from nothing.
  await resumeStrandedResults(project, store, repositories, report);

  // A claimed task with no active lease was claimed by a process that no
  // longer exists — the in-process path never survives a restart. Requeue it
  // so the queue simply runs it again: this is what makes recovery automatic
  // rather than "retry it manually". Anything resumed above has already been
  // finalized and is no longer claimed, so it is not handed back.
  //
  // No grace at boot: nothing in this process has claimed anything yet, so
  // every unleased claim on the store belongs to a process that is gone,
  // however recently it was made.
  const stranded = await reapStrandedWork(store, {
    claimedBefore: new Date().toISOString(),
  });
  report.requeuedTasks.push(...stranded.requeuedTasks);
  report.warnings.push(...stranded.warnings);

  // A run still `running` at boot died with its process. Its non-terminal
  // tasks are failed with an explanation rather than left in a phantom
  // in-progress state. The run closes as completed only when resumption
  // carried every one of its tasks to a terminal success.
  for (const run of await store.listRuns(500)) {
    if (run.status !== "running") {
      continue;
    }
    const detail = await store.getRun(run.id);
    let stranded = 0;
    for (const task of detail?.tasks ?? []) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        continue;
      }
      stranded += 1;
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
    const resumedWholeRun =
      stranded === 0 &&
      (detail?.tasks ?? []).length > 0 &&
      (detail?.tasks ?? []).every((task) => task.status === "integrated");
    if (resumedWholeRun) {
      const final = detail?.integrations.at(-1)?.canonicalVersion;
      await store.finishRun(run.id, "completed", final);
      continue;
    }
    await store.finishRun(run.id, "failed");
    report.failedRuns.push(run.id);
  }

  const eventful =
    report.failedRuns.length > 0 ||
    report.resumedTasks.length > 0 ||
    report.requeuedTasks.length > 0 ||
    report.expiredLeases.length > 0;
  if (eventful) {
    await store.appendAudit(undefined, {
      type: "recovery_completed",
      data: {
        failedRuns: report.failedRuns,
        resumedTasks: report.resumedTasks,
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

/**
 * How long a claim may sit with no lease behind it before it is treated as
 * dead work rather than live work.
 *
 * A run mints its lease inside the same transaction that claims the task, so
 * a live claim is only ever unleased for the microseconds between those two
 * rows being read by a sweep that reads them separately. Two minutes is far
 * past that and far short of the five-minute lease TTL, so this reclaims the
 * cases lease expiry cannot see — a lease settled while its task never
 * reached an outcome — without ever racing a run that is still going.
 */
export const CLAIMED_GRACE_MS = 2 * 60_000;

/** What one stranded-work sweep found and did about it. */
export interface StrandedWorkReport {
  /** Claimed tasks with nothing working on them, returned to the queue. */
  requeuedTasks: string[];
  /** Non-fatal problems, e.g. a row the store refused to requeue. */
  warnings: string[];
}

/**
 * What a thread is told when the work behind it is queued again.
 *
 * Fixed wording so the sweep can recognise its own line and not repeat it,
 * the same way the gateway's thread reconciliation recognises the endings it
 * writes.
 */
const RESTART_REQUEUE_LINE =
  "The deployment restarted while I was working on this, so the task has " +
  "been put back in the queue and will start again shortly.";

/**
 * Says in the thread that this task's work was interrupted and requeued.
 *
 * Without it the thread's last word is whatever progress line the dead
 * process happened to leave, which reads as an agent still thinking — the
 * complaint this whole path exists for. A restart is not the agent's silence
 * and should not look like it.
 *
 * Best effort by design, and idempotent: a thread that already carries this
 * line, or that has already been given an ending, is left alone.
 */
export async function announceRestartRequeue(
  store: CoordinationStore,
  task: SubmittedTask,
): Promise<boolean> {
  // The most recent page of the room. A thread whose work was in flight when
  // the process died is by definition recent, so one page finds it.
  const messages = await store.listChannelMessages(task.repositoryId, "", {
    limit: 200,
  });
  const root = messages.find((message) => message.taskId === task.id);
  if (root === undefined || root.endedAt !== undefined) {
    return false;
  }
  const replies = root.replies ?? [];
  if (replies.some((reply) => reply.content === RESTART_REQUEUE_LINE)) {
    return false;
  }
  await store.addChannelReply({
    repositoryId: task.repositoryId,
    messageId: root.id,
    kind: "system",
    authorId: "system",
    content: RESTART_REQUEUE_LINE,
  });
  return true;
}

/**
 * Returns work nothing is doing to the queue, and says so in its thread.
 *
 * The half of crash recovery that cannot only run at boot. A container
 * restart takes seconds and a work lease lives for five minutes, so the boot
 * pass looks at a lease that is still comfortably active — issued by a
 * process that no longer exists, heartbeated by nobody — decides the task is
 * being worked on, and never looks again. Lease expiry eventually returns
 * those tasks to the queue on its own; what it cannot return is a task whose
 * lease was already settled while its row stayed `claimed`, which is a run
 * that ended without an outcome for it. That row is claimed by nothing,
 * queued behind nothing, and waits forever.
 *
 * So this is a sweep, not a boot step: a claimed task with no active lease
 * behind it, older than {@link CLAIMED_GRACE_MS}, goes back to `submitted`
 * where the queue resume can pick it up.
 *
 * `claimedBefore` is how a caller states what it knows. Boot recovery passes
 * the current time, because nothing it can see is its own. A running process
 * passes the grace bound, so a claim made moments ago — possibly by itself —
 * is never mistaken for debris.
 *
 * The grace is only safe because a run leases what it claims: the lease is
 * minted in the claiming transaction, so live work is never unleased. The one
 * path that claims without leasing is a project with no user account to
 * register a worker under, which warns loudly when it takes that route and
 * has no queue sweep running over it.
 */
export async function reapStrandedWork(
  store: CoordinationStore,
  options: { claimedBefore?: string } = {},
): Promise<StrandedWorkReport> {
  const report: StrandedWorkReport = { requeuedTasks: [], warnings: [] };
  const claimedBefore =
    options.claimedBefore ??
    new Date(Date.now() - CLAIMED_GRACE_MS).toISOString();
  const candidates = (
    await store.listSubmittedTasks({ status: "claimed" })
  ).filter(
    (task) => task.claimedAt === undefined || task.claimedAt < claimedBefore,
  );
  if (candidates.length === 0) {
    // The common case, and the cheap one: no lease read, no channel read.
    return report;
  }
  const leased = new Set(
    (await store.listWorkLeases({ status: "active" })).map(
      (lease) => lease.taskId,
    ),
  );
  for (const task of candidates) {
    if (leased.has(task.id)) {
      continue;
    }
    try {
      await store.retrySubmittedTask(task.id);
    } catch (error) {
      // A row that has moved on since it was listed — cancelled from a
      // thread, completed by a run finishing between the two reads. Not this
      // sweep's business, and not worth failing the pass for.
      report.warnings.push(
        `Could not requeue stranded task ${task.id}: ${errorMessage(error)}`,
      );
      continue;
    }
    report.requeuedTasks.push(task.id);
    await announceRestartRequeue(store, task).catch((error: unknown) => {
      report.warnings.push(
        `Could not announce the requeue of ${task.id}: ${errorMessage(error)}`,
      );
    });
  }
  return report;
}

/**
 * Hands back everything this process is holding, on the way out.
 *
 * The graceful counterpart to recovery: a redeploy is a planned event and the
 * process gets a SIGTERM before it dies, which is long enough to say that the
 * work it was doing is no longer being done. Releasing the leases returns
 * their tasks to `submitted` immediately, so the container that replaces this
 * one finds queued work at boot and resumes it in seconds — instead of the
 * five minutes it takes an abandoned lease to expire, or forever when the
 * lease was already settled.
 *
 * Returns the ids of the tasks that went back to the queue.
 */
export async function drainInFlightWork(
  store: CoordinationStore,
): Promise<string[]> {
  const released = await releaseLocalRunnerLeases(store);
  const requeued = new Set(released);
  // Anything claimed with nothing behind it goes back too, whatever its age:
  // this process is leaving, so none of it is live.
  const stranded = await reapStrandedWork(store, {
    claimedBefore: new Date().toISOString(),
  });
  for (const taskId of stranded.requeuedTasks) {
    requeued.add(taskId);
  }
  if (released.length > 0) {
    const tasks = new Map(
      (await store.listSubmittedTasks()).map((task) => [task.id, task]),
    );
    for (const taskId of released) {
      const task = tasks.get(taskId);
      if (task !== undefined) {
        await announceRestartRequeue(store, task).catch(() => undefined);
      }
    }
  }
  return [...requeued];
}
