import type { CoordinationStore } from "@coord/persistence";
import type { SequencedAuditEvent } from "@coord/shared-types";

/**
 * Coordination metrics, derived entirely from the append-only audit chain.
 *
 * The audit log is the one record every execution path already writes —
 * local runs, remote workers, approvals — so deriving metrics from it needs
 * no new bookkeeping and cannot drift from what actually happened. The cost
 * is honesty about precision: a "true conflict" here is contention that
 * materially happened (a replan or a failed integration), matched back to
 * predictions by task identity.
 */

export interface ConflictMetrics {
  /** conflict_detected events recorded by the scheduler. */
  predictions: number;
  predictionsByDisposition: Record<string, number>;
  /** Replans and non-integrated integration outcomes: contention that happened. */
  materialized: number;
  /**
   * Predicted pairs where contention materialised on its own — a member
   * replanned, integrated onto a stale base, or failed to integrate.
   *
   * The only bucket that is evidence the prediction was worth making, because
   * it is the only one the scheduler did not author. This is the number to
   * read when asking whether arbitration earns its keep.
   */
  confirmedByContention: number;
  /**
   * Predicted pairs whose sole corroboration is the hold the scheduler itself
   * placed, after which everything settled quietly.
   *
   * Counted apart from `confirmedByContention` because it cannot be wrong. A
   * `blocked` or `sequenced` admission is what the scheduler *does* about a
   * prediction, so treating it as proof of the prediction lets arbitration
   * grade its own homework: every hold confirms itself, and the only
   * prediction that could ever be scored a false positive is one that was
   * never acted on. Whether these holds prevented a broken merge or cost a
   * task its turn for nothing is not knowable from the audit chain — it needs
   * a counterfactual the log cannot contain — so it is reported rather than
   * folded into either verdict.
   */
  confirmedByOwnHold: number;
  /** Predicted pairs the scheduler let run, where both members landed clean. */
  falsePositives: number;
  /** Predicted pairs whose members have not all reached an outcome yet. */
  openPredictions: number;
  /** Contention on tasks no prediction ever covered — missed conflicts. */
  unpredictedContention: number;
}

export interface ReworkMetrics {
  /** Tasks sent back to planning because canonical moved under them. */
  replansRequested: number;
  /** Integration attempts that ended conflict/validation_failed/policy_failed/empty. */
  integrationFailures: number;
  /** Extra task_started events beyond each task's first: repeat executions. */
  taskRestarts: number;
  /**
   * Tasks whose plan was refused before any editing happened. Rework avoided
   * rather than paid for: the counterpart of taskRestarts, which counts the
   * executions that did get repeated. Counted per task, not per submission —
   * a worker waiting on a deferral resubmits the same plan repeatedly.
   */
  planTimeDeferrals: number;
}

export interface ThroughputMetrics {
  tasksSubmitted: number;
  /** Tasks that moved canonical: they landed a change. */
  tasksIntegrated: number;
  /**
   * Tasks that succeeded without changing a file.
   *
   * A question answered, a file read out, an explanation written. The
   * coordinator settles these as `integrated` and the person who asked got
   * what they asked for, but there is no changeset and canonical never
   * moved, so `canonical_promoted` is never written and nothing here used to
   * count them. On a conversational deployment that is not a rounding error:
   * most turns in a chat are questions, and every one of them fell out of the
   * accounting between `tasksSubmitted` and `tasksIntegrated`.
   */
  tasksReported: number;
  tasksFailed: number;
  /** Tasks somebody stopped. Not a failure — nothing went wrong. */
  tasksCancelled: number;
  /**
   * Submitted tasks with no ending of any kind on the trail.
   *
   * The honest residual, and the only number here that is a question rather
   * than an answer. Some of it is work still running, which is fine and
   * expected. The rest is tasks whose run died between the claim and the
   * ending — a redeploy, a crashed process — leaving a row nothing will ever
   * settle and no event to say so. Kept separate from `tasksFailed` because
   * conflating "this failed" with "we do not know" is how a 40% hole in the
   * accounting reads as a healthy zero.
   */
  tasksUnaccounted: number;
  /** Mean milliseconds from task_submitted to canonical_promoted. */
  averageTimeToIntegrationMs: number | undefined;
}

export interface ApprovalMetrics {
  requested: number;
  decided: number;
  /** Mean milliseconds a human decision took, request to verdict. */
  averageDecisionMs: number | undefined;
}

/**
 * What coordination let happen, rather than what it prevented.
 *
 * Every other number here is about contention — predictions, rework, holds.
 * These are the opposite, and they are the only ones that describe the thing
 * this system does that a lock does not: two tasks working the same file at
 * the same time, and a file handed back before its holder finished.
 *
 * They are also the only numbers here that can be stated without a
 * counterfactual. "Collisions prevented" cannot be derived from an audit
 * chain — see {@link ConflictMetrics.confirmedByOwnHold} for why — but a
 * partial admission is an event that happened, and so is a release.
 */
export interface SharingMetrics {
  /** Admissions that granted part of a plan and withheld the rest. */
  partialAdmissions: number;
  /**
   * Of those, the ones that withheld something finer than a whole file.
   *
   * The distinction worth reporting: withholding a file is what any lease can
   * do, and withholding a function inside a granted file is not.
   */
  withinFileAdmissions: number;
  /** Distinct files granted to one task while another worked inside them. */
  filesSharedBetweenTasks: number;
  /** Times a task handed resources back while it was still running. */
  releases: number;
  /** Distinct files handed back mid-run. */
  releasedFiles: number;
  /**
   * Tasks that were held behind a blocker and started after that blocker
   * gave something up.
   *
   * Ordering is the whole of the claim: the task was refused, its blocker
   * released, and only then was it admitted. It does not prove the release
   * is *why* it started — a lease could have lapsed in the same window — so
   * it is reported as a sequence observed, not a cause established.
   */
  pickupsAfterRelease: number;
}

export interface CostMetrics {
  /** Total remote execution time across all work leases, in milliseconds. */
  leaseRuntimeMs: number;
  activeLeases: number;
  settledLeases: number;
}

export interface CoordinationMetrics {
  /**
   * How much of the audit chain the numbers cover: how many events were
   * counted, and the highest sequence among them. Under a project filter both
   * describe that project's slice, not the whole installation.
   */
  window: { events: number; toSequence: number };
  conflicts: ConflictMetrics;
  sharing: SharingMetrics;
  rework: ReworkMetrics;
  throughput: ThroughputMetrics;
  approvals: ApprovalMetrics;
  cost: CostMetrics;
}

export interface MetricsFilter {
  /**
   * Restricts to events stamped with this project id. Events that predate
   * project stamping are excluded from a filtered view rather than guessed.
   */
  projectId?: string;
}

const PAGE_SIZE = 5_000;

/**
 * Pages the chain, letting the store do the filtering.
 *
 * Pushing the project filter into the query matters once a deployment has
 * more than one project: reading every event and discarding most of them in
 * JavaScript made a single project's metrics cost the whole installation's
 * history.
 */
async function allAuditEvents(
  store: CoordinationStore,
  filter: MetricsFilter,
): Promise<SequencedAuditEvent[]> {
  const events: SequencedAuditEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await store.listAuditEvents({
      afterSequence: after,
      limit: PAGE_SIZE,
      ...(filter.projectId === undefined
        ? {}
        : { projectId: filter.projectId }),
    });
    events.push(...page);
    if (page.length < PAGE_SIZE) {
      return events;
    }
    after = page.at(-1)?.sequence ?? after;
  }
}

function pairKey(taskIds: readonly string[]): string {
  return [...taskIds].sort().join("\0");
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

export async function computeCoordinationMetrics(
  store: CoordinationStore,
  filter: MetricsFilter = {},
): Promise<CoordinationMetrics> {
  const events = await allAuditEvents(store, filter);

  const predictionsByDisposition: Record<string, number> = {};
  const predictedPairs = new Map<string, string[]>();
  const contendedTasks = new Set<string>();
  const deferredTasks = new Set<string>();
  const reportedTasks = new Set<string>();
  const cancelledTasks = new Set<string>();
  const integratedTasks = new Set<string>();
  const failedTasks = new Set<string>();
  const submittedAt = new Map<string, string>();
  const startCounts = new Map<string, number>();
  const approvalRequestedAt = new Map<string, string>();
  const integrationDurations: number[] = [];
  const approvalDurations: number[] = [];

  let predictions = 0;
  let replansRequested = 0;
  let integrationFailures = 0;

  let partialAdmissions = 0;
  let withinFileAdmissions = 0;
  let releases = 0;
  const sharedFiles = new Set<string>();
  const releasedFilePaths = new Set<string>();
  /** Tasks currently refused, and who they named as the reason. */
  const heldBehind = new Map<string, Set<string>>();
  /** Tasks that have released something since somebody was held behind them. */
  const releasedSince = new Set<string>();
  const pickedUp = new Set<string>();

  for (const { event } of events) {
    const taskId = event.taskId;
    switch (event.type) {
      case "conflict_detected": {
        predictions += 1;
        const disposition = String(event.data["disposition"] ?? "unknown");
        predictionsByDisposition[disposition] =
          (predictionsByDisposition[disposition] ?? 0) + 1;
        const taskIds = event.data["taskIds"];
        if (
          Array.isArray(taskIds) &&
          taskIds.every((entry) => typeof entry === "string")
        ) {
          predictedPairs.set(pairKey(taskIds), [...taskIds]);
        }
        break;
      }
      case "replan_requested": {
        replansRequested += 1;
        if (taskId !== undefined) {
          contendedTasks.add(taskId);
        }
        break;
      }
      case "plan_admitted": {
        const status = event.data["status"];
        if (event.data["partial"] === true) {
          partialAdmissions += 1;
          const withheld = Array.isArray(event.data["deferredResources"])
            ? (event.data["deferredResources"] as unknown[])
            : [];
          // A withheld symbol means the file it lives in was granted to this
          // task while somebody else was working inside it. A withheld file
          // means only that the file was kept whole, which every lease does.
          //
          // Type alone cannot tell those apart. Deferring a file also defers
          // every symbol claimed only through it, recorded one by one so
          // enforcement can check them and marked `implied` because they are
          // the same loss counted again. Reading type alone therefore called
          // every whole-file deferral a within-file split — precisely the
          // thing this number exists to distinguish — and reported sharing
          // that no lease had actually done.
          const finerThanFile = withheld.some(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              (entry as { resourceType?: unknown }).resourceType === "symbol" &&
              (entry as { implied?: unknown }).implied !== true,
          );
          if (finerThanFile) {
            withinFileAdmissions += 1;
            for (const file of event.data["grantedFiles"] as unknown[] ?? []) {
              if (typeof file === "string") {
                sharedFiles.add(file);
              }
            }
          }
        }
        if (
          taskId !== undefined &&
          (status === "approved" || status === "approved_with_constraints") &&
          [...(heldBehind.get(taskId) ?? [])].some((blocker) =>
            releasedSince.has(blocker),
          )
        ) {
          // Held, then its blocker gave something up, then admitted — in that
          // order. Recorded once per task however many times it resubmits.
          pickedUp.add(taskId);
        }
        if (
          (status === "blocked" || status === "sequenced") &&
          taskId !== undefined
        ) {
          const blockedBy = Array.isArray(event.data["blockedBy"])
            ? (event.data["blockedBy"] as unknown[])
            : [];
          const named = heldBehind.get(taskId) ?? new Set<string>();
          for (const blocker of blockedBy) {
            if (typeof blocker === "string") {
              named.add(blocker);
            }
          }
          heldBehind.set(taskId, named);
          // Deliberately NOT contention. This is the scheduler's own answer to
          // a prediction, and counting it as evidence for that prediction made
          // every hold self-confirming — arbitration marking its own homework.
          // It lands in its own bucket (`confirmedByOwnHold`) so the number
          // that survives is the contention nobody here authored.
          deferredTasks.add(taskId);
        }
        break;
      }
      case "ownership_released":
      case "blanket_claim_frozen": {
        // Both are a holder giving ground back while it is still running: one
        // because the agent said so, one because a repository-wide claim
        // narrowed to what its holder had actually taken.
        releases += 1;
        for (const file of (Array.isArray(event.data["files"])
          ? (event.data["files"] as unknown[])
          : [])) {
          if (typeof file === "string") {
            releasedFilePaths.add(file);
          }
        }
        if (taskId !== undefined) {
          releasedSince.add(taskId);
        }
        break;
      }
      case "validation_completed": {
        const status = event.data["status"];
        if (typeof status === "string" && status !== "integrated") {
          // "stale" is counted as contention, not as a failure: the work was
          // fine, the base moved. Everything else is a failed attempt.
          if (status === "stale") {
            if (taskId !== undefined) {
              contendedTasks.add(taskId);
            }
          } else {
            integrationFailures += 1;
            if (taskId !== undefined) {
              contendedTasks.add(taskId);
            }
          }
        }
        break;
      }
      case "task_submitted": {
        if (taskId !== undefined) {
          submittedAt.set(taskId, event.occurredAt);
        }
        break;
      }
      case "task_started": {
        if (taskId !== undefined) {
          startCounts.set(taskId, (startCounts.get(taskId) ?? 0) + 1);
        }
        break;
      }
      case "canonical_promoted": {
        if (taskId !== undefined) {
          integratedTasks.add(taskId);
          const submitted = submittedAt.get(taskId);
          if (submitted !== undefined) {
            const delta =
              new Date(event.occurredAt).getTime() -
              new Date(submitted).getTime();
            if (Number.isFinite(delta) && delta >= 0) {
              integrationDurations.push(delta);
            }
          }
        }
        break;
      }
      case "task_failed": {
        if (taskId !== undefined) {
          failedTasks.add(taskId);
        }
        break;
      }
      case "task_reported": {
        if (taskId !== undefined) {
          reportedTasks.add(taskId);
        }
        break;
      }
      case "task_cancelled": {
        if (taskId !== undefined) {
          cancelledTasks.add(taskId);
        }
        break;
      }
      case "approval_requested": {
        const id = event.data["approvalId"];
        if (typeof id === "string") {
          approvalRequestedAt.set(id, event.occurredAt);
        }
        break;
      }
      case "approval_decided": {
        const id = event.data["approvalId"];
        if (typeof id === "string") {
          const requested = approvalRequestedAt.get(id);
          if (requested !== undefined) {
            const delta =
              new Date(event.occurredAt).getTime() -
              new Date(requested).getTime();
            if (Number.isFinite(delta) && delta >= 0) {
              approvalDurations.push(delta);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Every way a task can be over. A prediction waits for its members to
  // finish before it means anything, and "finished" has to name all four
  // endings: a pair whose tasks answered a question and stopped was left
  // waiting forever on `canonical_promoted` events that were never coming,
  // so its verdict sat in `openPredictions` rather than being decided.
  const settledTasks = new Set<string>([
    ...integratedTasks,
    ...reportedTasks,
    ...failedTasks,
    ...cancelledTasks,
  ]);

  let confirmedByContention = 0;
  let confirmedByOwnHold = 0;
  let falsePositives = 0;
  let openPredictions = 0;
  const predictedTasks = new Set<string>();
  for (const taskIds of predictedPairs.values()) {
    for (const id of taskIds) {
      predictedTasks.add(id);
    }
    // Order matters, and it is the order of how much the evidence is worth.
    // Real contention settles a pair whatever else happened to it. Failing
    // that, a pair still in flight is not yet anything — a hold that has not
    // outlived its tasks may still be vindicated by a replan tomorrow, so it
    // waits rather than banking a verdict early. Only once every member has
    // finished does the absence of contention mean something, and then the
    // hold decides which kind of nothing it was: unfalsifiable if the
    // scheduler intervened, a clean refutation if it stood back and watched
    // both land.
    if (taskIds.some((id) => contendedTasks.has(id))) {
      confirmedByContention += 1;
    } else if (!taskIds.every((id) => settledTasks.has(id))) {
      openPredictions += 1;
    } else if (taskIds.some((id) => deferredTasks.has(id))) {
      confirmedByOwnHold += 1;
    } else {
      falsePositives += 1;
    }
  }
  let unpredictedContention = 0;
  for (const id of contendedTasks) {
    if (!predictedTasks.has(id)) {
      unpredictedContention += 1;
    }
  }

  let taskRestarts = 0;
  for (const count of startCounts.values()) {
    taskRestarts += Math.max(0, count - 1);
  }

  // Runtime cost comes from work leases, the platform's one directly
  // measured spend signal today.
  const leases = await store.listWorkLeases(
    filter.projectId === undefined ? {} : { projectId: filter.projectId },
  );
  const nowMs = Date.now();
  let leaseRuntimeMs = 0;
  let activeLeases = 0;
  let settledLeases = 0;
  for (const lease of leases) {
    const started = new Date(lease.issuedAt).getTime();
    const ended =
      lease.finishedAt !== undefined
        ? new Date(lease.finishedAt).getTime()
        : lease.status === "active"
          ? nowMs
          : started;
    leaseRuntimeMs += Math.max(0, ended - started);
    if (lease.status === "active") {
      activeLeases += 1;
    } else {
      settledLeases += 1;
    }
  }

  return {
    window: {
      events: events.length,
      toSequence: events.at(-1)?.sequence ?? 0,
    },
    conflicts: {
      predictions,
      predictionsByDisposition,
      materialized: contendedTasks.size,
      confirmedByContention,
      confirmedByOwnHold,
      falsePositives,
      openPredictions,
      unpredictedContention,
    },
    sharing: {
      partialAdmissions,
      withinFileAdmissions,
      filesSharedBetweenTasks: sharedFiles.size,
      releases,
      releasedFiles: releasedFilePaths.size,
      pickupsAfterRelease: pickedUp.size,
    },
    rework: {
      replansRequested,
      integrationFailures,
      taskRestarts,
      planTimeDeferrals: deferredTasks.size,
    },
    throughput: {
      tasksSubmitted: submittedAt.size,
      tasksIntegrated: integratedTasks.size,
      tasksReported: reportedTasks.size,
      tasksFailed: failedTasks.size,
      tasksCancelled: cancelledTasks.size,
      // Counted against the submissions this window actually saw, and by
      // membership rather than subtraction: a task can carry more than one
      // ending — a cancel landing on something already failing — so summing
      // the buckets and subtracting would report a negative remainder.
      tasksUnaccounted: [...submittedAt.keys()].filter(
        (id) => !settledTasks.has(id),
      ).length,
      averageTimeToIntegrationMs: average(integrationDurations),
    },
    approvals: {
      requested: approvalRequestedAt.size,
      decided: approvalDurations.length,
      averageDecisionMs: average(approvalDurations),
    },
    cost: {
      leaseRuntimeMs,
      activeLeases,
      settledLeases,
    },
  };
}
