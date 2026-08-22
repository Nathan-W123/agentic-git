import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";
import type { AuditEventType } from "@coord/shared-types";

import { computeCoordinationMetrics } from "./metrics.js";

/**
 * Metrics are derived purely from the audit chain, so the tests write the
 * same event shapes the runtime writes and assert on the classification.
 */

async function append(
  store: InMemoryCoordinationStore,
  type: AuditEventType,
  taskId: string | undefined,
  data: Record<string, unknown> = {},
): Promise<void> {
  await store.appendAudit(undefined, {
    type,
    ...(taskId === undefined ? {} : { taskId }),
    data,
  });
}

test("predictions are confirmed by contention and refuted by clean integration", async () => {
  const store = new InMemoryCoordinationStore();

  // Pair A/B: predicted, then B replans — a confirmed prediction.
  await append(store, "conflict_detected", undefined, {
    taskIds: ["task_a", "task_b"],
    disposition: "sequenced",
    score: 40,
  });
  await append(store, "replan_requested", "task_b", {});

  // Pair C/D: predicted, both integrate untouched — a false positive.
  await append(store, "conflict_detected", undefined, {
    taskIds: ["task_c", "task_d"],
    disposition: "concurrent",
    score: 10,
  });
  await append(store, "canonical_promoted", "task_c", {});
  await append(store, "canonical_promoted", "task_d", {});

  // Pair E/F: predicted, F still in flight — neither confirmed nor refuted.
  await append(store, "conflict_detected", undefined, {
    taskIds: ["task_e", "task_f"],
    disposition: "concurrent",
    score: 10,
  });
  await append(store, "canonical_promoted", "task_e", {});

  // Task G: never predicted, but replanned — a missed conflict.
  await append(store, "replan_requested", "task_g", {});

  const metrics = await computeCoordinationMetrics(store);
  assert.equal(metrics.conflicts.predictions, 3);
  assert.equal(metrics.conflicts.confirmedByContention, 1);
  assert.equal(metrics.conflicts.confirmedByOwnHold, 0);
  assert.equal(metrics.conflicts.falsePositives, 1);
  assert.equal(metrics.conflicts.openPredictions, 1);
  assert.equal(metrics.conflicts.unpredictedContention, 1);
  assert.deepEqual(metrics.conflicts.predictionsByDisposition, {
    sequenced: 1,
    concurrent: 2,
  });
  assert.equal(metrics.rework.replansRequested, 2);

  await store.close();
});

test("stale integrations count as contention, other failures as rework", async () => {
  const store = new InMemoryCoordinationStore();
  await append(store, "validation_completed", "task_stale", {
    status: "stale",
  });
  await append(store, "validation_completed", "task_broken", {
    status: "validation_failed",
  });
  await append(store, "validation_completed", "task_ok", {
    status: "integrated",
  });

  const metrics = await computeCoordinationMetrics(store);
  assert.equal(metrics.rework.integrationFailures, 1);
  assert.equal(metrics.conflicts.materialized, 2);

  await store.close();
});

test("a deferred plan confirms nothing until its tasks settle, and then only itself", async () => {
  const store = new InMemoryCoordinationStore();
  // Predicted, then the plan was stopped before any editing: no execution was
  // thrown away, and — the point of this test — no contention was observed
  // either. The hold is the scheduler's own answer to its own prediction.
  await append(store, "conflict_detected", "task_b", {
    taskIds: ["task_a", "task_b"],
    disposition: "sequence",
    score: 40,
    stage: "remote_plan_admission",
  });
  // Submitted twice while waiting, which is one deferred task, not two.
  await append(store, "plan_admitted", "task_b", { status: "sequenced" });
  await append(store, "plan_admitted", "task_b", { status: "sequenced" });
  await append(store, "plan_admitted", "task_a", { status: "approved" });

  // Mid-flight the hold has not outlived its tasks, so no verdict is banked:
  // a replan tomorrow would still vindicate the prediction properly.
  const midflight = await computeCoordinationMetrics(store);
  assert.equal(midflight.rework.planTimeDeferrals, 1);
  assert.equal(midflight.conflicts.openPredictions, 1);
  assert.equal(midflight.conflicts.confirmedByOwnHold, 0);
  assert.equal(midflight.conflicts.confirmedByContention, 0);

  // Both land clean. Nothing ever contended, so the hold is the only thing
  // corroborating the prediction — which is not evidence, and is counted
  // where it cannot be mistaken for any.
  await append(store, "canonical_promoted", "task_a", {});
  await append(store, "canonical_promoted", "task_b", {});

  const settled = await computeCoordinationMetrics(store);
  assert.equal(settled.conflicts.confirmedByOwnHold, 1);
  assert.equal(settled.conflicts.confirmedByContention, 0);
  assert.equal(settled.conflicts.falsePositives, 0);
  assert.equal(settled.conflicts.materialized, 0);
  assert.equal(settled.rework.planTimeDeferrals, 1);
  assert.equal(settled.rework.taskRestarts, 0);
  assert.equal(settled.rework.replansRequested, 0);

  await store.close();
});

test("a hold that prevented something and one that prevented nothing are told apart", async () => {
  const store = new InMemoryCoordinationStore();

  // Pair A/B — the scheduler held B, and contention then materialised on its
  // own: canonical moved and B had to replan. The prediction earned its keep.
  await append(store, "conflict_detected", undefined, {
    taskIds: ["task_a", "task_b"],
    disposition: "sequence",
    score: 40,
  });
  await append(store, "plan_admitted", "task_b", { status: "blocked" });
  await append(store, "replan_requested", "task_b", { revision: "rev_2" });
  await append(store, "canonical_promoted", "task_a", {});
  await append(store, "canonical_promoted", "task_b", {});

  // Pair C/D — the same detection, the same hold, and then nothing at all.
  // No replan, no stale base, no failed validation: both landed clean, and
  // whether the hold saved a merge or cost D its turn is unknowable.
  await append(store, "conflict_detected", undefined, {
    taskIds: ["task_c", "task_d"],
    disposition: "sequence",
    score: 40,
  });
  await append(store, "plan_admitted", "task_d", { status: "blocked" });
  await append(store, "canonical_promoted", "task_c", {});
  await append(store, "canonical_promoted", "task_d", {});

  const metrics = await computeCoordinationMetrics(store);
  // The whole reason the buckets are separate. Counting a hold as proof of
  // the prediction it answers made these two indistinguishable, and made the
  // only prediction that could ever be scored a false positive one the
  // scheduler never acted on.
  assert.equal(metrics.conflicts.predictions, 2);
  assert.equal(metrics.conflicts.confirmedByContention, 1);
  assert.equal(metrics.conflicts.confirmedByOwnHold, 1);
  assert.equal(metrics.conflicts.falsePositives, 0);
  assert.equal(metrics.conflicts.openPredictions, 0);
  // One replan, and only the replan: the two holds are rework the scheduler
  // avoided rather than contention it observed.
  assert.equal(metrics.conflicts.materialized, 1);
  assert.equal(metrics.rework.planTimeDeferrals, 2);

  await store.close();
});

test("throughput, restarts, and approval latency come from event timestamps", async () => {
  const store = new InMemoryCoordinationStore();
  await append(store, "task_submitted", "task_1", {});
  await append(store, "task_started", "task_1", {});
  await append(store, "task_started", "task_1", {}); // one restart
  await append(store, "canonical_promoted", "task_1", {});
  await append(store, "task_failed", "task_2", {});
  await append(store, "approval_requested", "task_1", {
    approvalId: "approval_1",
  });
  await append(store, "approval_decided", "task_1", {
    approvalId: "approval_1",
  });

  const metrics = await computeCoordinationMetrics(store);
  assert.equal(metrics.throughput.tasksSubmitted, 1);
  assert.equal(metrics.throughput.tasksIntegrated, 1);
  assert.equal(metrics.throughput.tasksFailed, 1);
  assert.notEqual(metrics.throughput.averageTimeToIntegrationMs, undefined);
  assert.equal(metrics.rework.taskRestarts, 1);
  assert.equal(metrics.approvals.requested, 1);
  assert.equal(metrics.approvals.decided, 1);
  assert.notEqual(metrics.approvals.averageDecisionMs, undefined);

  await store.close();
});

test("a project filter keeps only events stamped with that project", async () => {
  const store = new InMemoryCoordinationStore();
  await append(store, "task_submitted", "task_here", {
    projectId: "project_here",
  });
  await append(store, "task_submitted", "task_there", {
    projectId: "project_there",
  });
  await append(store, "task_submitted", "task_unstamped", {});

  const metrics = await computeCoordinationMetrics(store, {
    projectId: "project_here",
  });
  assert.equal(metrics.throughput.tasksSubmitted, 1);
  assert.equal(metrics.window.events, 1);

  await store.close();
});

test("sharing counts what coordination allowed, not what it prevented", async () => {
  const store = new InMemoryCoordinationStore();

  // A whole-file partial: task_b keeps the file it asked for, minus one it
  // did not get. Any lease can do this, so it is counted but not as sharing.
  await append(store, "plan_admitted", "task_b", {
    status: "approved_with_constraints",
    partial: true,
    grantedFiles: ["src/b.ts"],
    deferredResources: [
      { resourceType: "file", resourceId: "src/shared.ts", heldBy: ["task_a"] },
    ],
  });

  // A within-file partial: task_c is granted src/mod.ts while task_a is
  // working on a function inside it. This is the one nothing else can do.
  await append(store, "plan_admitted", "task_c", {
    status: "approved_with_constraints",
    partial: true,
    grantedFiles: ["src/mod.ts"],
    deferredResources: [
      { resourceType: "symbol", resourceId: "alpha", heldBy: ["task_a"] },
    ],
  });
  // The same file shared again, by a third task. Counted once as a file.
  await append(store, "plan_admitted", "task_d", {
    status: "approved_with_constraints",
    partial: true,
    grantedFiles: ["src/mod.ts"],
    deferredResources: [
      { resourceType: "symbol", resourceId: "beta", heldBy: ["task_a"] },
    ],
  });

  // A release and a pickup, in the order that makes the claim: task_e is
  // refused and names task_a, task_a hands a file back, task_e then starts.
  await append(store, "plan_admitted", "task_e", {
    status: "sequenced",
    blockedBy: ["task_a"],
  });
  await append(store, "ownership_released", "task_a", {
    files: ["src/handed-back.ts"],
    stage: "scope_release",
  });
  await append(store, "plan_admitted", "task_e", { status: "approved" });

  // A task admitted without ever being held is not a pickup.
  await append(store, "plan_admitted", "task_f", { status: "approved" });

  const metrics = await computeCoordinationMetrics(store);

  assert.equal(metrics.sharing.partialAdmissions, 3);
  assert.equal(metrics.sharing.withinFileAdmissions, 2);
  // src/mod.ts, once, however many tasks shared it. src/b.ts does not count:
  // nothing was working inside it.
  assert.equal(metrics.sharing.filesSharedBetweenTasks, 1);
  assert.equal(metrics.sharing.releases, 1);
  assert.equal(metrics.sharing.releasedFiles, 1);
  assert.equal(metrics.sharing.pickupsAfterRelease, 1);
});

test("a task admitted before its blocker released is not counted as a pickup", async () => {
  // Order is the whole of the claim. Without it, any task that was ever held
  // and later ran would look like a pickup.
  const store = new InMemoryCoordinationStore();
  await append(store, "plan_admitted", "task_b", {
    status: "sequenced",
    blockedBy: ["task_a"],
  });
  await append(store, "plan_admitted", "task_b", { status: "approved" });
  await append(store, "ownership_released", "task_a", {
    files: ["src/late.ts"],
    stage: "scope_release",
  });

  const metrics = await computeCoordinationMetrics(store);
  assert.equal(metrics.sharing.releases, 1);
  assert.equal(metrics.sharing.pickupsAfterRelease, 0);
});
