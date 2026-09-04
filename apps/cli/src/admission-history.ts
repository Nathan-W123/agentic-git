import type { CoordinationStore } from "@coord/persistence";
import type { TaskId } from "@coord/shared-types";

/**
 * What the audit trail remembers about a task's admissions.
 *
 * Two readers, lifted out of `worker-operations` so that the two admission
 * paths can share the narrowing they were always meant to share. Both of them
 * want these counts, and `lease-admission` importing them from
 * `worker-operations` was the one edge that made the dependency mutual — which
 * is why the remote path could not simply call the local path's narrowing and
 * ended up with none at all.
 *
 * They belong here on their own terms too: neither is a worker operation.
 * Both read the durable admission record and answer a question about one
 * task's history, which is the same question wherever it is asked from.
 */

/**
 * How often running this task has been refused outright: in an unbroken run
 * ending at the most recent admission, and over the task's whole life.
 *
 * Deliberately blind to *which* task did the blocking. An earlier version
 * counted only while the blocking set stayed identical, on the reasoning that
 * a task refused by two different holders is making progress through a queue.
 * That reasoning is wrong in exactly the case this mechanism exists for: three
 * tasks contending for one function block each other in a rotating order, so
 * the blocking set changes every turn, the run resets every turn, and the
 * escalation is never reached. The loop survives the fix meant to break it.
 *
 * Escalating on a genuine queue costs nothing anyway, which is what makes the
 * blunter rule safe. Sequencing behind whoever currently holds the resource is
 * the correct answer whether that holder is the same one as last time or not —
 * it grants no permission to execute either way.
 *
 * `total` is the backstop. A task that alternates between refusals and other
 * non-approving answers never builds a consecutive run, so the unbroken count
 * alone still has a hole; the lifetime count has none, because it only ever
 * rises.
 *
 * The admission record is the source because the count has to outlive the
 * lease. The loop this exists to break releases its lease on every turn, and
 * the next turn may be a different worker entirely, so anything held in memory
 * would reset exactly when it mattered.
 */
export async function blockedAdmissionHistory(
  store: CoordinationStore,
  taskId: TaskId,
): Promise<{ consecutive: number; total: number }> {
  const events = await store.listAuditEvents({
    taskId,
    types: ["plan_admitted"],
  });
  let consecutive = 0;
  let counting = true;
  let total = 0;
  for (const entry of [...events].reverse()) {
    if (entry.event.data["status"] === "blocked") {
      total += 1;
      if (counting) {
        consecutive += 1;
      }
      continue;
    }
    counting = false;
  }
  return { consecutive, total };
}

/**
 * Whether this task has already spent an execution on a partial admission.
 *
 * A task may prove that its nominally free files cannot be changed without
 * the withheld ones. That attempt is returned to the queue, and allowing the
 * next lease to split the same plan again would repeat the empty execution
 * forever. The audit trail survives that lease boundary, so it is the stable
 * signal that subsequent admissions must decide the plan as one unit.
 */
export async function wasPartiallyAdmitted(
  store: CoordinationStore,
  taskId: TaskId,
): Promise<boolean> {
  return (
    await store.listAuditEvents({
      taskId,
      types: ["plan_admitted"],
    })
  ).some((entry) => entry.event.data["partial"] === true);
}
