import {
  CodeIntelligenceService,
  groundedIntentAssessor,
  groundPlan,
} from "@coord/code-intelligence";
import {
  BLOCKED_ADMISSION_LIFETIME_CAP,
  BLOCKED_ATTEMPTS_BEFORE_SEQUENCING,
  DEFAULT_PLAN_RETRY_MS,
  PlanAdmissionController,
  isDeferredScopeFollowUp,
  type ActivePlan,
  type PlanAdmissionRequest,
  type PlanAuthority,
  type PlanAuthorityDecision,
} from "@coord/coordinator";
import type { CoordinationStore, WorkLease } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import {
  planAdmissionApproved,
  planAdmissionPartial,
  reducePlanScope,
  type AgentPlan,
  type TaskId,
} from "@coord/shared-types";

import { blockedAdmissionHistory } from "./worker-operations.js";

/**
 * What makes one admission answer different from another.
 *
 * Everything that changes what a reader would do about it, and nothing that
 * merely changes with the clock: how long a task has been waiting is not a new
 * decision, and including it would make every repetition look novel — which is
 * the whole failure this exists to prevent.
 */
function admissionFingerprint(data: Readonly<Record<string, unknown>>): string {
  const blockedBy = Array.isArray(data["blockedBy"])
    ? [...(data["blockedBy"] as unknown[])].map(String).sort()
    : [];
  const grantedFiles = Array.isArray(data["grantedFiles"])
    ? [...(data["grantedFiles"] as unknown[])].map(String).sort()
    : [];
  return JSON.stringify({
    status: data["status"] ?? null,
    blockedBy,
    partial: data["partial"] === true,
    grantedFiles,
    admittedAfterWait: data["admittedAfterWait"] === true,
  });
}

/** The pair a conflict is between, and what the detector made of it. */
function conflictFingerprint(data: Readonly<Record<string, unknown>>): string {
  const taskIds = Array.isArray(data["taskIds"])
    ? [...(data["taskIds"] as unknown[])].map(String).sort()
    : [];
  return JSON.stringify({
    taskIds,
    score: data["score"] ?? null,
    disposition: data["disposition"] ?? null,
  });
}

/**
 * Arbitration for tasks running in this process, against every other task
 * running in the same repository — including those belonging to other runs.
 *
 * The remote worker path has done this since protocol version 2: a worker
 * submits its plan, the plan is decided against the plans on every other
 * active lease, and only an approved answer buys agent time. The in-process
 * runner never joined in, because it never held a lease, so its plans were
 * invisible to that arbitration and it could see nothing of anyone else's.
 * Two channel dispatches therefore admitted overlapping plans every time and
 * the collision was left to exact-base integration at landing time — which
 * across two runs does not replan the loser, it fails it.
 *
 * This is the same decision procedure reading the same durable state, wired to
 * the seam the coordinator offers between planning a task and letting it edit.
 */
export class LeasePlanAuthority implements PlanAuthority {
  private readonly store: CoordinationStore;
  private readonly leaseIdForTask: ReadonlyMap<TaskId, string>;
  private readonly repositories: RepositoryService;
  private readonly intelligence: CodeIntelligenceService;
  private readonly admissions: PlanAdmissionController;
  private readonly maxWaitMs: number;
  /** When each task was first told to wait, for the bound below. */
  private readonly waitingSince = new Map<TaskId, number>();

  public constructor(options: {
    store: CoordinationStore;
    /** The lease this run holds for each task it is executing. */
    leaseIdForTask: ReadonlyMap<TaskId, string>;
    repositories?: RepositoryService;
    intelligence?: CodeIntelligenceService;
    admissions?: PlanAdmissionController;
    /**
     * How long one task may be held behind others before it is let through
     * regardless.
     *
     * A holder that dies stops heartbeating and its lease lapses within the
     * lease TTL, so an honest queue always drains. This bound is for the case
     * that reasoning does not cover — a holder that stays alive and never
     * finishes — where waiting forever would be worse than the duplicated
     * effort exact-base integration already knows how to absorb.
     */
    maxWaitMs?: number;
  }) {
    this.store = options.store;
    this.leaseIdForTask = options.leaseIdForTask;
    this.repositories = options.repositories ?? new RepositoryService();
    this.intelligence =
      options.intelligence ?? new CodeIntelligenceService(this.repositories);
    this.admissions = options.admissions ?? new PlanAdmissionController();
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
  }

  public async admit(
    request: PlanAdmissionRequest,
  ): Promise<PlanAuthorityDecision> {
    const leaseId = this.leaseIdForTask.get(request.task.id);
    if (leaseId === undefined) {
      // This run holds nothing durable for the task, so it has neither a way
      // to publish this plan nor a right to arbitrate on it. Proceeding is the
      // documented fallback, and exact-base integration still holds.
      return { outcome: "admitted", plan: request.plan };
    }

    // Reap anything whose holder stopped heartbeating before reading the set:
    // a lapsed lease is not work in progress, and treating it as though it
    // were would queue this task behind a process that is gone.
    await this.store.expireWorkLeases(new Date().toISOString());
    const lease = await this.store.getWorkLease(leaseId);
    if (lease === undefined || lease.status !== "active") {
      return { outcome: "admitted", plan: request.plan };
    }

    const { active, approvedLeaseIds } = await this.executingPlans(lease);
    if (active.length === 0) {
      // Nothing else is executing here. The plan still has to be recorded —
      // that record is what the *next* arrival arbitrates against, and
      // skipping it is precisely how this path stayed invisible — but there is
      // nothing to decide against, so the repository index nobody needs is not
      // built.
      return await this.publish(request, lease, request.plan, approvedLeaseIds);
    }

    // Only reached when something else really is running: indexing a
    // repository is the most expensive step in the control plane, and a task
    // that is alone in its repository must not pay for it.
    const index = await this.intelligence.index(
      request.repository,
      request.baseVersion.revision,
    );
    const enriched = this.intelligence.enrichPlan(
      groundPlan(request.plan, index),
      index,
    );

    // How often this task has already been sent away to narrow a plan it may
    // not be able to narrow. Past the escalation point the answer changes from
    // "plan again" to "wait your turn", which is what stops two tasks
    // contending for one function from replanning at each other forever.
    const refusals = await blockedAdmissionHistory(this.store, request.task.id);
    const blockedAttempts = Math.max(
      refusals.consecutive,
      refusals.total >= BLOCKED_ADMISSION_LIFETIME_CAP
        ? BLOCKED_ATTEMPTS_BEFORE_SEQUENCING
        : 0,
    );

    const decided = this.admissions.admit({
      plan: enriched,
      agentId: request.task.agentId,
      baseRevision: request.baseVersion.revision,
      baseVersion: request.baseVersion.sequence,
      active,
      planRevision: request.planRevision,
      // A task that exists because an earlier admission was partial is decided
      // whole: one split per lineage is what stops a task shedding scope round
      // after round, paying for another agent run each time.
      partialAdmission: !isDeferredScopeFollowUp(request.task.objective),
      resourcesInFile: (file) => this.intelligence.resourcesInFile(index, file),
      symbolRangesInFile: (file) =>
        this.intelligence.symbolRangesInFile(index, file),
      intentAssessment: groundedIntentAssessor(index),
      blockedAttempts,
    });

    // What goes on the lease is what was actually granted. On a partial
    // admission that is the reduced plan; recording the whole one would hold
    // resources for this task that this task was refused.
    const grantedPlan = planAdmissionPartial(decided)
      ? reducePlanScope(enriched, decided.deferredResources ?? [])
      : enriched;

    const saved = await this.store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan: grantedPlan, admission: decided },
      observedApprovedLeaseIds: approvedLeaseIds,
    });
    if (saved.outcome === "stale") {
      // Someone was admitted between the read and the write, so this decision
      // was made against a view that no longer exists. Decide again.
      return await this.admit(request);
    }
    if (saved.outcome === "lease_lost") {
      return { outcome: "admitted", plan: request.plan };
    }
    const admission =
      saved.outcome === "already_admitted"
        ? saved.lease.plan!.admission
        : decided;

    // Reported once per collision, not once per time we look at it. The same
    // two plans stay in conflict for as long as one of them is running, and
    // the wait is re-decided the whole time.
    const seenConflicts = new Set(
      (
        await this.store.listAuditEvents({
          taskId: request.task.id,
          types: ["conflict_detected"],
        })
      ).map((entry) => conflictFingerprint(entry.event.data)),
    );
    for (const assessment of admission.conflicts) {
      const data = {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        taskIds: assessment.taskIds,
        score: assessment.score,
        disposition: assessment.disposition,
        evidence: assessment.evidence,
        explanation: assessment.explanation,
        stage: "local_plan_admission",
      };
      if (seenConflicts.has(conflictFingerprint(data))) {
        continue;
      }
      seenConflicts.add(conflictFingerprint(data));
      await this.store.appendAudit(undefined, {
        type: "conflict_detected",
        taskId: request.task.id,
        data,
      });
    }

    const approved = planAdmissionApproved(admission);
    const waited = this.waitedMs(request.task.id, approved);
    const forced = !approved && waited >= this.maxWaitMs;

    await this.record(request, {
      type: "plan_admitted",
      taskId: request.task.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        leaseId: lease.id,
        status: admission.status,
        blockedBy: admission.blockedBy,
        constraints: admission.constraints,
        explanation: admission.explanation,
        planRevision: request.planRevision,
        ...(planAdmissionPartial(admission)
          ? {
              partial: true,
              grantedFiles: grantedPlan.expectedFiles,
              deferredResources: admission.deferredResources,
            }
          : {}),
        ...(forced ? { admittedAfterWait: true, waitedMs: waited } : {}),
      },
    });

    if (approved) {
      this.waitingSince.delete(request.task.id);
      return { outcome: "admitted", plan: grantedPlan };
    }
    if (forced) {
      // Let through without an approved contract on the lease: the record
      // still says this task was sequenced, because it was. Exact-base
      // integration is what keeps the outcome correct from here.
      this.waitingSince.delete(request.task.id);
      return { outcome: "admitted", plan: request.plan };
    }
    return {
      outcome: "deferred",
      retryAfterMs: admission.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS,
      blockedBy: admission.blockedBy,
      explanation: admission.explanation,
    };
  }

  /**
   * Appends an admission event, unless it would repeat the last one.
   *
   * A task waiting its turn is re-decided every retry interval for as long as
   * the holder runs, and each pass reaches the same answer — that is the
   * mechanism working, not news. Writing it every time turned one arbitration
   * into a message every fifteen seconds in the room, for the whole of a
   * holder's execution.
   *
   * The comparison is against the durable record rather than something held in
   * memory, so a task deferred by one run and reconsidered by the next is not
   * announced twice either. Only a decision that actually changed — sequenced
   * becoming partial, a different blocker, the wait finally ending — is worth
   * a line, and each of those is.
   */
  private async record(
    request: PlanAdmissionRequest,
    event: {
      type: "plan_admitted";
      taskId: TaskId;
      data: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const previous = (
      await this.store.listAuditEvents({
        taskId: event.taskId,
        types: ["plan_admitted"],
      })
    ).at(-1);
    if (
      previous !== undefined &&
      admissionFingerprint(previous.event.data) === admissionFingerprint(event.data)
    ) {
      return;
    }
    await this.store.appendAudit(undefined, event);
  }

  /**
   * Records a plan nothing contends for, so later arrivals can see it.
   *
   * Separate from the deciding path because there is genuinely nothing to
   * decide: with no other plan in the repository every admission procedure
   * returns the same answer, and the only thing that matters is that the plan
   * is on the lease before anyone else looks.
   */
  private async publish(
    request: PlanAdmissionRequest,
    lease: WorkLease,
    plan: AgentPlan,
    approvedLeaseIds: readonly string[],
  ): Promise<PlanAuthorityDecision> {
    const admission = this.admissions.admit({
      plan,
      agentId: request.task.agentId,
      baseRevision: request.baseVersion.revision,
      baseVersion: request.baseVersion.sequence,
      active: [],
      planRevision: request.planRevision,
    });
    const saved = await this.store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan, admission },
      observedApprovedLeaseIds: approvedLeaseIds,
    });
    if (saved.outcome === "stale") {
      // Someone arrived while this was being written. There is now something
      // to arbitrate against, so go round again and actually decide.
      return await this.admit(request);
    }
    await this.record(request, {
      type: "plan_admitted",
      taskId: request.task.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        leaseId: lease.id,
        status: admission.status,
        blockedBy: admission.blockedBy,
        constraints: admission.constraints,
        explanation: admission.explanation,
        planRevision: request.planRevision,
      },
    });
    this.waitingSince.delete(request.task.id);
    return { outcome: "admitted", plan };
  }

  /**
   * The plans executing in this repository right now, and the exact set of
   * leases that view was read from.
   *
   * The ids travel back into `saveWorkLeasePlan` so the store can refuse a
   * write whose view has since changed, which is what stops two runs
   * arbitrating at the same moment from both being approved.
   */
  private async executingPlans(
    lease: WorkLease,
  ): Promise<{ active: ActivePlan[]; approvedLeaseIds: string[] }> {
    const leases = await this.store.listWorkLeases({
      status: "active",
      repositoryId: lease.repositoryId,
    });
    const admitted = leases.filter(
      (candidate) =>
        candidate.id !== lease.id &&
        candidate.plan !== undefined &&
        planAdmissionApproved(candidate.plan.admission),
    );
    const tasks = await this.store.listSubmittedTasks({
      repositoryId: lease.repositoryId,
    });
    const agentFor = new Map(tasks.map((task) => [task.id, task.agentId]));
    return {
      active: admitted.map(
        (candidate): ActivePlan => ({
          taskId: candidate.taskId,
          agentId: agentFor.get(candidate.taskId) ?? candidate.workerId,
          // Guarded by the filter above.
          plan: (candidate.plan as { plan: AgentPlan }).plan,
        }),
      ),
      approvedLeaseIds: admitted.map((candidate) => candidate.id).sort(),
    };
  }

  /** Milliseconds this task has been waiting, starting the clock if new. */
  private waitedMs(taskId: TaskId, approved: boolean): number {
    if (approved) {
      return 0;
    }
    const started = this.waitingSince.get(taskId);
    if (started === undefined) {
      this.waitingSince.set(taskId, Date.now());
      return 0;
    }
    return Date.now() - started;
  }
}
