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
  assert.equal(metrics.conflicts.confirmedPredictions, 1);
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

test("a deferred plan counts as contention that cost nothing to execute", async () => {
  const store = new InMemoryCoordinationStore();
  // Predicted, then the plan was stopped before any editing: the prediction
  // is confirmed, but unlike a replan no execution was thrown away.
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

  const metrics = await computeCoordinationMetrics(store);
  assert.equal(metrics.rework.planTimeDeferrals, 1);
  assert.equal(metrics.rework.taskRestarts, 0);
  assert.equal(metrics.rework.replansRequested, 0);
  assert.equal(metrics.conflicts.confirmedPredictions, 1);

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
