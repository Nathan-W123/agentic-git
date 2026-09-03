/**
 * Work taken and reported by an editor rather than by a worker process.
 *
 * ### Why this is not just `leaseWork` with a different caller
 *
 * A desktop worker is a machine Kumi drives: it polls, it is handed a
 * workspace, it runs an agent under a plan the control plane admitted first,
 * and it reports a changeset it collected itself. An editor is the other way
 * round. The person is already in Claude Code or Cursor with the repository
 * open, and Kumi is a tool that editor calls. Nothing here can be woken,
 * nothing here can be given a workspace, and nothing here plans before it
 * starts, because by the time Kumi hears from it the agent is already the one
 * holding the keyboard.
 *
 * Three consequences shape this file:
 *
 * - **The lease is taken, but the plan is not admitted with it.** Taking the
 *   lease is what stops a desktop worker grabbing the same task; admitting a
 *   plan at that moment would mean a blanket claim held for the whole window,
 *   with a scope nobody can narrow because there is no holder to ask. So
 *   admission happens at report time, against the paths the diff actually
 *   touched, which is a *narrower* claim than a worker's planned one and
 *   arrives when it can be decided rather than guessed.
 * - **The window is long.** A worker heartbeats every minute and holds a
 *   five-minute lease. A person reading a diff in their editor does not, so
 *   the lease runs for half an hour and `extendEditorWork` is how it is kept.
 * - **The worker row is the lease's, not the editor's.** `work_leases.worker_id`
 *   is a foreign key, so a lease needs a row. One row per person per editor,
 *   reused, and retired by the ordinary sweep once it has been idle and holds
 *   nothing. Presence is answered somewhere else entirely, in memory, because
 *   an editor that has not spoken for three minutes is not dead.
 */

import type { PlanAdmissionController } from "@coord/coordinator";
import type {
  CoordinationStore,
  SubmittedTask,
  WorkLease,
  WorkerRecord,
} from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import type {
  AgentPlan,
  CanonicalVersion,
  ChangeSet,
  FilePatch,
} from "@coord/shared-types";

import type { CoordinatorProject } from "./project.js";
import {
  acceptWorkResult,
  admitWorkPlan,
  configuredRepositoryParallelism,
  editorAdapterName,
  type WorkResultAcceptance,
  type WorkResultServices,
} from "./worker-operations.js";

/**
 * How long an editor holds a task before it must say it is still there.
 *
 * Half an hour, against a worker's five minutes, and the difference is not a
 * safety margin — it is what a lease means here. A worker's lease is renewed
 * by a timer beside the process, so five minutes only ever asks "is that
 * process alive". An editor's is renewed by the agent choosing to call a
 * tool, and between two such calls a person can read a diff, go and look at
 * something, and come back. Anything short enough to catch an abandoned
 * editor quickly is short enough to take work away from one that is running.
 */
export const EDITOR_LEASE_TTL_MS = 30 * 60 * 1000;

/** The longest an editor may extend one hold to in a single request. */
export const EDITOR_LEASE_MAX_EXTENSION_MS = 60 * 60 * 1000;

/** The task an editor has just been given, in the terms it needs to start. */
export interface EditorAssignment {
  readonly leaseId: string;
  readonly task: SubmittedTask;
  readonly repository: { readonly id: string; readonly branch: string };
  readonly baseRevision: string;
  readonly baseVersion: number;
  readonly expiresAt: string;
}

/** What reporting a result came to. */
export type EditorReportOutcome =
  | {
      outcome: "accepted";
      integrationStatus?: NonNullable<WorkResultAcceptance["integrationStatus"]>;
      requeued?: boolean;
    }
  | { outcome: "refused"; reason: string }
  | { outcome: "lease_lost"; reason: string };

/**
 * The worker row one person's editor leases through.
 *
 * Reused rather than minted per take. The row exists because a lease needs a
 * foreign key, not because anything is registering a machine, and a fresh row
 * per task would put the growth this deployment just removed back in through
 * a different door. Named after the editor so a fleet view can tell a laptop
 * from a Cursor window, and so two editors on one account do not share a row.
 */
async function editorWorker(
  store: CoordinationStore,
  input: {
    userId: string;
    organizationId: string;
    vendor: string;
    label: string;
  },
): Promise<WorkerRecord> {
  const existing = (
    await store.listWorkers({ organizationId: input.organizationId })
  ).find(
    (worker) => worker.userId === input.userId && worker.name === input.label,
  );
  if (existing !== undefined) {
    await store.touchWorker(existing.id, new Date().toISOString());
    return { ...existing, lastSeenAt: new Date().toISOString() };
  }
  return await store.registerWorker({
    userId: input.userId,
    organizationId: input.organizationId,
    name: input.label,
    // Exactly the vendor this editor is, and never `generic-cli`. An editor
    // is one agent, and a list that matched agents with no adapter set would
    // let a Claude Code window take work addressed to somebody's Codex.
    adapters: [input.vendor],
    version: "editor",
  });
}

/**
 * Hands one queued task to an editor, or answers that there is nothing.
 *
 * The narrowing is doubled on purpose, and each half answers a different
 * question. `repositoryIds` is what this caller may *reach* — an organization
 * member gets every repository in the project, a collaborator gets the ones
 * they were granted. `claimableBy` is what they may *run*: an editor offers
 * one person's vendor login, so it may only take that person's work.
 */
export async function takeEditorWork(
  store: CoordinationStore,
  input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    /** The repositories this caller may be handed work from. Never widened. */
    repositoryIds: readonly string[];
    /** Which CLI this editor is, e.g. `claude`, `codex`, `cursor`. */
    vendor: string;
    /** How the row is named, e.g. `Claude Code (editor)`. */
    label: string;
    ttlMs?: number;
  },
  repositories = new RepositoryService(),
  project?: CoordinatorProject,
): Promise<EditorAssignment | undefined> {
  const reachable = new Set(input.repositoryIds);
  if (reachable.size === 0) {
    return undefined;
  }
  const pending = (
    await store.listSubmittedTasks({
      projectId: input.projectId,
      status: "submitted",
      kind: "task",
    })
  ).filter(
    (task) =>
      reachable.has(task.repositoryId) &&
      // Pre-filtered as well as clamped in the store's own clause below. It
      // saves a canonical resolve per task somebody else owns, and it keeps
      // the two statements of the rule beside each other.
      (task.submittedBy === undefined || task.submittedBy === input.actorId),
  );
  if (pending.length === 0) {
    return undefined;
  }
  const worker = await editorWorker(store, {
    userId: input.actorId,
    organizationId: input.organizationId,
    vendor: input.vendor,
    label: input.label,
  });
  // One resolve per repository, not one per candidate. Reading canonical is a
  // git call, and the queue is ordered by age rather than grouped by
  // repository, so a run of five tasks in one repository used to cost five
  // identical resolves before the first lease was even attempted.
  const versions = new Map<string, CanonicalVersion | undefined>();
  const repositoryParallelism = configuredRepositoryParallelism();
  for (const next of pending) {
    const required = editorAdapterName(project, next);
    if (required !== undefined && required !== input.vendor) {
      continue;
    }
    if (!versions.has(next.repositoryId)) {
      const stored = await store.getRepository(next.repositoryId);
      versions.set(
        next.repositoryId,
        stored === undefined
          ? undefined
          : await repositories
              .getCanonicalVersion({
                id: stored.id,
                path: stored.path,
                branch: stored.branch,
              })
              .catch(() => undefined),
      );
    }
    const version = versions.get(next.repositoryId);
    if (version === undefined) {
      // A repository this control plane cannot read is not one an editor can
      // be told to check out. Skipped rather than thrown: the next candidate
      // may be in a repository that is perfectly fine.
      continue;
    }
    const leased = await store.leaseNextTask({
      workerId: worker.id,
      taskId: next.id,
      projectId: input.projectId,
      repositoryId: next.repositoryId,
      baseRevision: version.revision,
      ttlMs: input.ttlMs ?? EDITOR_LEASE_TTL_MS,
      repositoryParallelism,
      claimableBy: input.actorId,
      kinds: ["task"],
    });
    if (leased === undefined) {
      continue;
    }
    const stored = await store.getRepository(next.repositoryId);
    await store.appendAudit(undefined, {
      type: "task_started",
      taskId: leased.task.id,
      data: {
        projectId: leased.task.projectId,
        repositoryId: leased.task.repositoryId,
        workerId: worker.id,
        leaseId: leased.lease.id,
        baseRevision: leased.lease.baseRevision,
        remote: true,
        editor: input.label,
      },
    });
    return {
      leaseId: leased.lease.id,
      task: leased.task,
      repository: {
        id: leased.task.repositoryId,
        branch: stored?.branch ?? "main",
      },
      baseRevision: leased.lease.baseRevision,
      baseVersion: version.sequence,
      expiresAt: leased.lease.expiresAt,
    };
  }
  return undefined;
}

/** The active lease an editor is holding for one task, if it still holds it. */
export async function editorLeaseForTask(
  store: CoordinationStore,
  taskId: string,
): Promise<WorkLease | undefined> {
  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const leases = await store.listWorkLeases({ status: "active" });
  return leases.find((lease) => lease.taskId === taskId);
}

/**
 * Pushes an editor's hold out, so a long turn does not lose its task.
 *
 * Bounded, and bounded per call rather than cumulatively: an editor that
 * keeps asking is an editor that keeps working, and the thing this protects
 * against is one request claiming a task for a day, not a person taking a
 * long afternoon over a hard change.
 */
export async function extendEditorWork(
  store: CoordinationStore,
  input: { leaseId: string; ttlMs: number },
): Promise<string | undefined> {
  const now = new Date();
  await store.expireWorkLeases(now.toISOString());
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined || lease.status !== "active") {
    return undefined;
  }
  const ttlMs = Math.min(
    Math.max(input.ttlMs, 60_000),
    EDITOR_LEASE_MAX_EXTENSION_MS,
  );
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await store.heartbeatWorkLease(input.leaseId, now.toISOString(), expiresAt);
  return expiresAt;
}

/**
 * Every repository path a set of patches touches, the old side of a rename
 * included.
 *
 * A rename is one patch with two paths, and only one of them is the file the
 * patch is keyed on. Claiming just that one would let an agent rename a file
 * out from under a second agent that is holding it under its old name, which
 * is precisely the collision admission exists to catch. Git names the other
 * side in the patch text, so it is read from there rather than guessed.
 */
export function pathsTouched(patches: readonly FilePatch[]): string[] {
  const paths = new Set<string>();
  for (const patch of patches) {
    paths.add(patch.path);
    for (const line of patch.patch.split("\n")) {
      const renamed = /^rename from (.+)$/u.exec(line);
      if (renamed?.[1] !== undefined) {
        paths.add(renamed[1]);
      }
    }
  }
  return [...paths];
}

/**
 * The plan an editor's work turns out to have been.
 *
 * Written from the diff rather than from an intention, which is the whole
 * difference between this and a worker's plan. A worker declares where it is
 * going and is admitted against that declaration before it moves; an editor
 * has already been, so the honest claim is the set of files it came back
 * with. That is strictly narrower than anything it could have declared up
 * front, and it is decidable: `admitWorkPlan` arbitrates it against whatever
 * else is executing in the repository right now, and will reduce it if
 * somebody else holds one of those files.
 */
export function editorPlan(
  task: SubmittedTask,
  patches: readonly FilePatch[],
): AgentPlan {
  const paths = pathsTouched(patches);
  return {
    taskId: task.id,
    objective: task.objective,
    expectedFiles: paths,
    expectedSymbols: [],
    dependencies: [],
    commands: [...task.validationCommands],
    externalAccess: [],
    // Not "high", for the reason a blanket claim is not: the level decides
    // whether a human is asked to approve, and "this came from an editor" is
    // not evidence that the change is dangerous.
    riskLevel: "medium",
    intent: "Reported from an editor; scope is the files the diff touched",
  };
}

/** The changeset an editor's diff amounts to. */
export function editorChangeSet(input: {
  task: SubmittedTask;
  lease: WorkLease;
  baseVersion: number;
  patches: readonly FilePatch[];
  summary: string;
  now?: string;
}): ChangeSet {
  const createdAt = input.now ?? new Date().toISOString();
  return {
    id: `cs-editor-${input.lease.id}`,
    taskId: input.task.id,
    baseVersion: input.baseVersion,
    baseRevision: input.lease.baseRevision,
    patches: [...input.patches],
    // Empty rather than invented. A worker records what it ran because it ran
    // it; an editor's agent ran whatever it ran on somebody's own machine,
    // and writing "tests passed" here on its say-so would put a claim in the
    // audit trail that nothing checked.
    commandsRun: [],
    tests: [],
    dependenciesChanged: [],
    symbolsChanged: [],
    riskAssessment: { level: "medium", reasons: ["Reported from an editor"] },
    agentExplanation: input.summary,
    createdAt,
  };
}

/**
 * Whether a refusal from the result path means "your hold went away" rather
 * than "your work was no good".
 *
 * The window really can close inside the call: the checks at the top of
 * `reportEditorWork` pass, integration takes a second or two, and the lease
 * reaches its expiry in between. Reporting that as a refusal sends an editor
 * off to redo work that was fine, so the two are told apart here.
 *
 * Deliberately not every `lease is …`. A lease that is `failed` or
 * `completed` is a lease something else already settled, and "take the task
 * again and report the same diff" is the wrong advice for both: the first
 * needs a person, and the second already landed.
 */
export function readsAsLapsedHold(reason: string): boolean {
  return (
    reason === "lease is expired" ||
    reason === "lease is released" ||
    reason.startsWith("lease was lost")
  );
}

/**
 * Admits what an editor did and integrates it, or says why not.
 *
 * The order is the point. Admission comes first and can still refuse or
 * narrow, so an editor that wandered into a file another agent is holding
 * gets the same answer a worker would; then the ordinary result path runs
 * completely unchanged, which is what keeps exact-base integration, replay,
 * validation and canonical advance identical whichever end the work came
 * from.
 */
export async function reportEditorWork(
  store: CoordinationStore,
  input: {
    leaseId: string;
    actorId: string;
    status: "completed" | "failed" | "released";
    patches: readonly FilePatch[];
    summary: string;
    detail?: string;
  },
  services: WorkResultServices & {
    admissions?: PlanAdmissionController;
  } = {},
): Promise<EditorReportOutcome> {
  const now = new Date().toISOString();
  await store.expireWorkLeases(now);
  const lease = await store.getWorkLease(input.leaseId);
  if (lease === undefined || lease.status !== "active") {
    return {
      outcome: "lease_lost",
      reason: `This hold is ${lease?.status ?? "gone"}. Take the task again before reporting.`,
    };
  }
  const task = await store.getSubmittedTask(lease.taskId);
  if (task === undefined) {
    return { outcome: "lease_lost", reason: "The task is gone." };
  }

  if (input.status === "released") {
    // Given back rather than failed, and the difference is what the room is
    // told. A release is "I have not started this and somebody else should",
    // which the store answers by returning the task to `submitted`; failing it
    // would end the task and post that the agent could not do it.
    const settled = await store.finishWorkLease(
      input.leaseId,
      "released",
      now,
      input.detail ?? "Given back from an editor",
    );
    if (!settled) {
      await store.expireWorkLeases(now);
      return { outcome: "lease_lost", reason: "The hold had already gone." };
    }
    return { outcome: "accepted" };
  }

  if (input.status === "failed") {
    // Straight down the ordinary failure path, which runs before the
    // plan-first gate for exactly this reason: work that did not land has no
    // plan to admit, and refusing it for missing paperwork would turn "I
    // could not do this" into "the control plane rejected your report".
    const accepted = await acceptWorkResult(
      store,
      {
        leaseId: input.leaseId,
        status: "failed",
        actorId: input.actorId,
        plan: {},
        changeSet: {},
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      },
      services,
    );
    return accepted.accepted
      ? { outcome: "accepted" }
      : { outcome: "refused", reason: accepted.reason ?? "not accepted" };
  }

  const admitted = await admitWorkPlan(
    store,
    {
      leaseId: input.leaseId,
      actorId: input.actorId,
      plan: editorPlan(task, input.patches),
    },
    services,
  );
  if (admitted.outcome === "lease_lost") {
    return { outcome: "lease_lost", reason: admitted.reason };
  }
  if (admitted.outcome === "rejected") {
    return { outcome: "refused", reason: admitted.reason };
  }
  if (admitted.admission.status !== "approved") {
    return {
      outcome: "refused",
      reason:
        `Another agent is holding files this change touches, so this was ` +
        `${admitted.admission.status} rather than approved. ` +
        (admitted.admission.explanation.trim() === ""
          ? "Try again once that work lands."
          : admitted.admission.explanation),
    };
  }

  // Re-read rather than reuse: admission may have reduced the plan, and the
  // reduced one is the contract the changeset is held to.
  const held = await store.getWorkLease(input.leaseId);
  const contract = held?.plan?.plan;
  if (contract === undefined) {
    return {
      outcome: "lease_lost",
      reason: "The admitted plan went away before the result could be filed.",
    };
  }
  // Read from the revision the lease pinned, never taken from the caller. It
  // is the sequence number that says which canonical state this diff is
  // against, and a value an editor supplied could name any of them.
  const stored = await store.getRepository(lease.repositoryId);
  const baseVersion =
    stored === undefined
      ? undefined
      : await (services.repositories ?? new RepositoryService())
          .getVersionAtRevision(
            {
              id: stored.id,
              path: stored.path,
              branch: stored.branch,
            },
            lease.baseRevision,
          )
          .catch(() => undefined);
  if (baseVersion === undefined) {
    return {
      outcome: "refused",
      reason:
        `Kumi cannot read revision ${lease.baseRevision} in that repository ` +
        "any more, so there is nothing to measure this diff against.",
    };
  }
  const accepted = await acceptWorkResult(
    store,
    {
      leaseId: input.leaseId,
      status: "completed",
      actorId: input.actorId,
      plan: contract,
      changeSet: editorChangeSet({
        task,
        lease,
        baseVersion: baseVersion.sequence,
        patches: input.patches,
        summary: input.summary,
      }),
    },
    services,
  );
  if (!accepted.accepted) {
    const reason = accepted.reason ?? "The result was not accepted.";
    return readsAsLapsedHold(reason)
      ? {
          outcome: "lease_lost",
          reason:
            `Your hold ran out while this was landing (${reason}). Nothing ` +
            "was lost: take the task again and report the same diff.",
        }
      : { outcome: "refused", reason };
  }
  return {
    outcome: "accepted",
    ...(accepted.integrationStatus === undefined
      ? {}
      : { integrationStatus: accepted.integrationStatus }),
    ...(accepted.requeued === undefined ? {} : { requeued: accepted.requeued }),
  };
}
