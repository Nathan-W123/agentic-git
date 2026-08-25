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
  blanketPlan,
  contestedPlanResources,
  deferredScopeObjective,
  freezePlanFromWorkingChanges,
  isDeferredScopeFollowUp,
  type ActivePlan,
  type BlanketClaimRequest,
  type BlanketFreezeRequest,
  type DeferredScopeRequest,
  type PlanAdmissionRequest,
  type SalvagedConflictRequest,
  type PlanAuthority,
  type PlanAuthorityDecision,
  type WaitingWork,
  type WaitingWorkRequest,
} from "@coord/coordinator";
import type { CoordinationStore, WorkLease } from "@coord/persistence";
import { RepositoryService } from "@coord/repository-service";
import {
  isBlanketClaim,
  planAdmissionApproved,
  planAdmissionPartial,
  reducePlanScope,
  type AgentPlan,
  type PlanAdmission,
  type TaskId,
} from "@coord/shared-types";

import {
  blockedAdmissionHistory,
  wasPartiallyAdmitted,
} from "./worker-operations.js";

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
  /** See the constructor option of the same name. */
  private readonly blanketClaims: boolean;
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
    /**
     * Whether a task alone in its repository may be granted all of it without
     * planning. On by default; a deployment that would rather every task keep
     * describing itself sets COORD_BLANKET_CLAIM=0.
     */
    blanketClaims?: boolean;
  }) {
    this.store = options.store;
    this.leaseIdForTask = options.leaseIdForTask;
    this.repositories = options.repositories ?? new RepositoryService();
    this.intelligence =
      options.intelligence ?? new CodeIntelligenceService(this.repositories);
    this.admissions = options.admissions ?? new PlanAdmissionController();
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
    this.blanketClaims = options.blanketClaims ?? true;
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

    const executing = await this.executingPlans(lease);
    const { approvedLeaseIds } = executing;
    let active = executing.active;
    if (active.length === 0) {
      // Nothing else is executing here. The plan still has to be recorded —
      // that record is what the *next* arrival arbitrates against, and
      // skipping it is precisely how this path stayed invisible — but there is
      // nothing to decide against, so the repository index nobody needs is not
      // built.
      return await this.publish(request, lease, request.plan, approvedLeaseIds);
    }
    const alreadySplit = await wasPartiallyAdmitted(
      this.store,
      request.task.id,
    );

    // A repository-wide claim is answered before the index is built. There is
    // nothing to arbitrate against a claim that covers everything — the
    // answer is the same whatever this plan says — and paying the most
    // expensive step in the control plane to reach a foregone conclusion
    // would make every arrival behind a blanket holder cost more than the
    // plan it is waiting for.
    let blanket = active.find((entry) => isBlanketClaim(entry.plan));
    if (blanket !== undefined && blanket.plan.expectedFiles.length > 0) {
      // The arrival is what narrows it, not the holder's own timer.
      //
      // A repository-wide claim used to be given back only when its holder
      // next looked — a poll on the coordinator side — so an arrival landed
      // in the gap and was refused for as long as that gap lasted, then
      // waited out its own retry on top. Two agents on unrelated files
      // queued for tens of seconds for no reason either of them could see.
      //
      // The claim carries the estimate it was granted against, so this is
      // decidable here and now: narrow the holder to what its objective said
      // it would touch, and arbitrate this plan against that instead of
      // refusing it. If the write is refused somebody else got there first,
      // and the claim stands — the refusal below is still the answer.
      const narrowed = await this.narrowBlanketHolder(
        blanket,
        request.baseVersion.sequence,
      );
      if (narrowed !== undefined) {
        active = active.map((entry) =>
          entry.taskId === blanket?.taskId ? narrowed : entry,
        );
        blanket = undefined;
      }
    }
    if (blanket !== undefined) {
      const explanation =
        `Task ${blanket.taskId} holds a repository-wide claim; it is ` +
        "narrowed to what it has touched as soon as it notices this task, " +
        "and this plan is decided against that";
      // The same bound the deciding path applies, for the same reason. A
      // holder that writes nothing never freezes, so without this a task
      // behind a blanket claim would be the one refusal in the system with no
      // way out of it — and exact-base integration is a better answer than
      // waiting on a holder that is never going to narrow.
      const waited = this.waitedMs(request.task.id, false);
      // Initial work eventually falls back to exact-base integration rather
      // than waiting forever. A live widening cannot: letting it through
      // would grant a running agent scope another task still owns.
      const forced =
        request.revising !== true &&
        !alreadySplit &&
        waited >= this.maxWaitMs;
      // Recorded like every other refusal. A hold nobody can see is what made
      // this path look asleep, and returning early from here was how a
      // repository-wide hold came to be the only decision that left no trace.
      // `record` compares against the durable trail, so a task re-decided
      // every retry interval is still announced once per decision.
      await this.record(request, {
        type: "plan_admitted",
        taskId: request.task.id,
        data: {
          ...(request.projectId === undefined
            ? {}
            : { projectId: request.projectId }),
          repositoryId: request.repository.id,
          leaseId: lease.id,
          status: "sequenced",
          blockedBy: [blanket.taskId],
          constraints: [
            "Resubmit once the repository-wide claim is narrowed or released",
          ],
          explanation,
          planRevision: request.planRevision,
          ...(forced ? { admittedAfterWait: true, waitedMs: waited } : {}),
        },
      });
      if (forced) {
        this.waitingSince.delete(request.task.id);
        return { outcome: "admitted", plan: request.plan };
      }
      return {
        outcome: "deferred",
        retryAfterMs: DEFAULT_PLAN_RETRY_MS,
        blockedBy: [blanket.taskId],
        explanation,
      };
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
      // The caller's veto first: a mid-execution replan cannot act on a
      // narrower plan than it asked for, and offering one would write a
      // reduced contract to the lease that the running agent knows nothing
      // about. Then the lineage rule — one split per task, so a task cannot
      // shed scope round after round, each round costing another agent run.
      partialAdmission:
        request.partialAdmission === false
          ? false
          : !isDeferredScopeFollowUp(request.task.objective) && !alreadySplit,
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

    let admission = decided;
    if (!(request.revising === true && !planAdmissionApproved(decided))) {
      const saved = await this.store.saveWorkLeasePlan({
        leaseId: lease.id,
        submission: { plan: grantedPlan, admission: decided },
        observedApprovedLeaseIds: approvedLeaseIds,
        // Without this a task revising its own approved plan would be answered
        // `already_admitted` and handed back its *old* contract as though it
        // covered the new plan — approving a widening nobody arbitrated,
        // which is the precise failure this path exists to prevent.
        ...(request.revising === true ? { replaceApproved: true } : {}),
      });
      if (saved.outcome === "stale") {
        // Someone was admitted between the read and the write, so this
        // decision was made against a view that no longer exists. Decide
        // again.
        return await this.admit(request);
      }
      if (saved.outcome === "lease_lost") {
        return { outcome: "admitted", plan: request.plan };
      }
      admission =
        saved.outcome === "already_admitted"
          ? saved.lease.plan!.admission
          : decided;
    }
    // A refused live widening leaves the old approved contract on the lease.
    // Replacing it with this sequenced decision would make the task's current
    // files look unowned while the agent is still working — and would make a
    // retry impossible to distinguish from a task that was never admitted.

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
    const forced =
      request.revising !== true &&
      !alreadySplit &&
      !approved &&
      waited >= this.maxWaitMs;

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
      return {
        outcome: "admitted",
        plan: grantedPlan,
        // Carried only when it narrowed the plan. The executor needs it to
        // tell a file this decision withheld from one nobody arbitrated.
        ...(planAdmissionPartial(admission) ? { admission } : {}),
      };
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
   * The whole repository, for a task nobody is competing with.
   *
   * The check is deliberately stricter than "no approved plan is executing":
   * any other active lease at all disqualifies the claim, including one whose
   * holder has not planned yet. A blanket claim admitted alongside a task
   * that is mid-plan would refuse that task everything the moment it
   * submitted, and it has already paid for the plan by then.
   *
   * The grant is written under the same compare-and-swap every admission
   * uses, so a claim and an admission decided at the same instant cannot both
   * be recorded. A refused write is not an error: it means somebody arrived,
   * and the caller simply plans as it always did.
   */
  public async claimRepository(
    request: BlanketClaimRequest,
  ): Promise<AgentPlan | undefined> {
    if (!this.blanketClaims) {
      return undefined;
    }
    const leaseId = this.leaseIdForTask.get(request.task.id);
    if (leaseId === undefined) {
      // Nothing durable to publish the claim on, so nothing would stop a
      // second task being admitted straight into it.
      return undefined;
    }
    await this.store.expireWorkLeases(new Date().toISOString());
    const lease = await this.store.getWorkLease(leaseId);
    if (lease === undefined || lease.status !== "active") {
      return undefined;
    }
    if (lease.plan !== undefined) {
      // A contract already exists for this task — a resumed turn, or a retry
      // after a deferral. Replacing it with a wider one is precisely what the
      // immutability rule on approved admissions forbids.
      return undefined;
    }
    const others = (
      await this.store.listWorkLeases({
        status: "active",
        repositoryId: lease.repositoryId,
      })
    ).filter((candidate) => candidate.id !== lease.id);
    if (others.length > 0) {
      return undefined;
    }
    // Recorded on the claim so the next arrival can narrow it on contact
    // instead of waiting out the holder's poll and its own retry.
    const plan = blanketPlan(
      request.task,
      undefined,
      request.estimatedFiles,
    );
    const admission = this.admissions.admit({
      plan,
      agentId: request.task.agentId,
      baseRevision: request.baseVersion.revision,
      baseVersion: request.baseVersion.sequence,
      active: [],
      planRevision: 1,
    });
    if (!planAdmissionApproved(admission)) {
      return undefined;
    }
    const saved = await this.store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan, admission },
      // Nothing else is admitted here, and the write is refused if that
      // stopped being true between the read above and this line.
      observedApprovedLeaseIds: [],
    });
    if (saved.outcome !== "saved") {
      return undefined;
    }
    await this.store.appendAudit(undefined, {
      type: "blanket_claim_granted",
      taskId: request.task.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        leaseId: lease.id,
        baseRevision: request.baseVersion.revision,
        planningCallsSaved: 1,
      },
    });
    return plan;
  }

  /**
   * Narrows a blanket claim to what its holder has actually touched, the
   * moment anybody else is in the repository.
   *
   * The worktree is read here, between deciding to freeze and writing the
   * result, and never sampled from anything that polls: a file written a
   * second ago belongs to this task, and handing it to the arriving one would
   * put two agents in it. A refused write — somebody's admission landed
   * first — re-reads the worktree rather than reusing this one, for the same
   * reason.
   */
  public async freezeBlanketClaim(
    request: BlanketFreezeRequest,
  ): Promise<AgentPlan | undefined> {
    if (!isBlanketClaim(request.plan)) {
      return undefined;
    }
    const leaseId = this.leaseIdForTask.get(request.task.id);
    if (leaseId === undefined) {
      return undefined;
    }
    await this.store.expireWorkLeases(new Date().toISOString());
    const lease = await this.store.getWorkLease(leaseId);
    if (lease === undefined || lease.status !== "active") {
      return undefined;
    }
    const others = (
      await this.store.listWorkLeases({
        status: "active",
        repositoryId: lease.repositoryId,
      })
    ).filter((candidate) => candidate.id !== lease.id);
    if (others.length === 0) {
      // Still alone. A claim narrowed for nobody costs this task scope it may
      // still need and buys no one anything.
      return undefined;
    }
    const approvedLeaseIds = others
      .filter(
        (candidate) =>
          candidate.plan !== undefined &&
          planAdmissionApproved(candidate.plan.admission),
      )
      .map((candidate) => candidate.id)
      .sort();
    const changes = await request.observe();
    // Nothing written yet is not a reason to keep the whole repository.
    //
    // It used to be. A freeze on no observed writes would not narrow the
    // claim, it would erase it — the holder left claiming nothing at the
    // exact moment somebody else needs the repository, and the arrival
    // admitted straight into files the holder is about to write. So the claim
    // was kept whole until the holder's first edit.
    //
    // The flaw was treating "has written nothing" as a brief startup blip. It
    // is the entire span between an agent starting and its first edit, which
    // for a real coding agent is however long it spends reading — and every
    // arrival in that window was refused everything, which is most of why
    // partial admission so rarely got the chance to do anything.
    //
    // What is used instead is a declaration rather than an observation: the
    // anchored estimate the coordinator granted this claim against, built
    // from paths, directories and symbols the objective actually named. A
    // task whose objective could not produce one is never granted a blanket
    // claim at all, so an empty list here means an older claim from before
    // this existed, and those still wait for the first write.
    const narrowTo =
      changes.length > 0
        ? changes
        : request.estimatedFiles.map((path) => ({
            path,
            status: "modified" as const,
          }));
    if (narrowTo.length === 0) {
      return undefined;
    }
    const frozen = freezePlanFromWorkingChanges(request.plan, narrowTo);
    const admission: PlanAdmission = this.admissions.admit({
      plan: frozen,
      agentId: request.task.agentId,
      baseRevision: request.baseVersion.revision,
      baseVersion: request.baseVersion.sequence,
      // A narrowing of a claim that already covered the repository cannot
      // collide with anything: everything it keeps, it already held.
      active: [],
      planRevision: request.planRevision + 1,
    });
    const saved = await this.store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan: frozen, admission },
      observedApprovedLeaseIds: approvedLeaseIds,
      // The one legitimate rewrite of an approved contract, for the same
      // reason mid-execution arbitration is: this is narrower than what was
      // already granted, so nobody's decision is invalidated by it.
      replaceApproved: true,
    });
    if (saved.outcome === "stale") {
      return await this.freezeBlanketClaim(request);
    }
    if (saved.outcome === "lease_lost") {
      return undefined;
    }
    await this.store.appendAudit(undefined, {
      type: "blanket_claim_frozen",
      taskId: request.task.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        leaseId: lease.id,
        files: frozen.expectedFiles,
        directories:
          frozen.claim?.kind === "frozen" ? frozen.claim.directories : [],
        arrivedTasks: others.map((candidate) => candidate.taskId).sort(),
      },
    });
    return frozen;
  }

  /**
   * Who is queued behind this task, and on which of the resources it holds.
   *
   * Read from the same durable state `admit` writes: a task that was refused
   * still has its plan and its non-approved admission saved on its own lease,
   * and that admission names the holders it is waiting for. So the queue is
   * already recorded — it was simply never read from the holder's side, which
   * is why an agent was never told it had anything worth handing back.
   *
   * Lapsed leases are reaped first. A waiter whose process died is not
   * waiting, and telling a working agent to hurry up for it would be a lie.
   */
  public async listWaitingOn(
    request: WaitingWorkRequest,
  ): Promise<readonly WaitingWork[]> {
    const leaseId = this.leaseIdForTask.get(request.task.id);
    if (leaseId === undefined) {
      // Nothing durable holds this task's plan, so nothing was ever decided
      // against it and nobody can be queued behind it.
      return [];
    }
    await this.store.expireWorkLeases(new Date().toISOString());
    const lease = await this.store.getWorkLease(leaseId);
    if (lease === undefined || lease.status !== "active") {
      return [];
    }
    const others = (
      await this.store.listWorkLeases({
        status: "active",
        repositoryId: lease.repositoryId,
      })
    ).filter((candidate) => candidate.id !== lease.id);
    const waiting: WaitingWork[] = [];
    for (const candidate of others) {
      const submission = candidate.plan;
      if (
        submission === undefined ||
        planAdmissionApproved(submission.admission)
      ) {
        // An approved contract is a peer, not a waiter: it is executing
        // alongside this task on resources nobody contended for.
        continue;
      }
      if (!submission.admission.blockedBy.includes(request.task.id)) {
        continue;
      }
      const contested = contestedPlanResources(request.plan, submission.plan);
      const total =
        contested.files.length +
        contested.symbols.length +
        contested.apis.length +
        contested.schemas.length +
        contested.configKeys.length +
        contested.tests.length +
        contested.services.length;
      if (total === 0) {
        // Blocked by this task for something it no longer claims — a plan
        // narrowed since the refusal, most likely. The next retry admits it.
        continue;
      }
      waiting.push({
        taskId: candidate.taskId,
        ...contested,
        explanation: submission.admission.explanation,
      });
    }
    return waiting;
  }

  /**
   * Queues the files this task planned, was granted, and had withheld.
   *
   * The agent's own patches for those files are deliberately not carried
   * forward. They were written against a revision another task is in the
   * middle of rewriting, so replaying them later would apply a diff to a base
   * that no longer exists. The paths are recorded; the content is not
   * resurrected — the follow-up is planned fresh against whatever canonical
   * looks like once the holder is done.
   */
  public async deferRemainder(request: DeferredScopeRequest): Promise<void> {
    const deferred = request.admission.deferredResources ?? [];
    if (deferred.length === 0) {
      return;
    }
    // The submitted row, not the definition the coordinator runs on. A
    // `TaskDefinition` carries neither `submittedBy` nor the model and effort
    // a channel picked, and a follow-up without the first cannot resolve
    // credentials at all — it would be queued and then never able to run.
    const original = (
      await this.store.listSubmittedTasks({
        repositoryId: request.repository.id,
      })
    ).find((candidate) => candidate.id === request.task.id);
    const followUp = await this.store.submitTask({
      repositoryId: request.repository.id,
      ...(request.projectId === undefined
        ? {}
        : { projectId: request.projectId }),
      objective: deferredScopeObjective(
        request.task.objective,
        deferred,
        // A granted file whose patch was held back for reaching a withheld
        // symbol lost its other edits with it. The follow-up covers those, or
        // that work is gone as quietly as the deferred files would have been.
        Object.keys(request.split.withheldSymbols).sort(),
      ),
      agentId: request.task.agentId,
      validationCommands: request.task.validationCommands,
      // Whose account this spends. The original's owner, never a default:
      // this is the same work, so it is the same person paying for it.
      ...(original?.submittedBy === undefined
        ? {}
        : { submittedBy: original.submittedBy }),
      // What the channel chose for this agent. Dropping them would run the
      // remainder of one request on different settings from the rest of it.
      ...(original?.model === undefined ? {} : { model: original.model }),
      ...(original?.effort === undefined ? {} : { effort: original.effort }),
      // Whatever conversation the original was asked inside is as much the
      // follow-up's background as it was its own. `conversationId` is
      // deliberately not carried: submitting a turn settles the conversation's
      // previous turn, and this is the same turn finishing, not the next one.
      ...(request.task.context === undefined
        ? {}
        : { context: request.task.context }),
    });
    await this.store.appendAudit(undefined, {
      type: "task_submitted",
      taskId: followUp.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        objective: followUp.objective,
        deferredFrom: request.task.id,
        deferredResources: deferred,
        discardedPatches: request.split.deferred
          .map((patch) => patch.path)
          .sort(),
      },
    });
  }

  /**
   * Queues the files a conflict held back, once the rest of them are in
   * canonical.
   *
   * The same shape as {@link deferRemainder} and for the same reason, but
   * from the other kind of partial admission: there the plan authority
   * withheld resources before the agent ran, here integration promoted what
   * still applied and handed back what had collided. The follow-up carries
   * the deferred-scope marker either way, which is what keeps one division
   * per task — without it a task could shed a file per round forever, each
   * round costing an agent run.
   *
   * The contested patches are not carried forward. They conflicted precisely
   * because the revision they were written against moved, so replaying them
   * would apply a diff to a base that no longer exists; the coordinator
   * records them on the audit log as context for whoever picks this up.
   */
  public async deferSalvagedConflict(
    request: SalvagedConflictRequest,
  ): Promise<string | undefined> {
    const paths = [
      ...new Set(request.deferred.map((patch) => patch.path)),
    ].sort();
    if (paths.length === 0) {
      return undefined;
    }
    // The submitted row rather than the definition, for the same reason
    // `deferRemainder` reads it: a `TaskDefinition` carries neither
    // `submittedBy` nor the model and effort a channel picked, and a follow-up
    // without the first is queued and then never able to resolve credentials.
    const original = (
      await this.store.listSubmittedTasks({
        repositoryId: request.repository.id,
      })
    ).find((candidate) => candidate.id === request.task.id);
    const followUp = await this.store.submitTask({
      repositoryId: request.repository.id,
      ...(request.projectId === undefined
        ? {}
        : { projectId: request.projectId }),
      objective: deferredScopeObjective(request.task.objective, [], paths),
      agentId: request.task.agentId,
      validationCommands: request.task.validationCommands,
      ...(original?.submittedBy === undefined
        ? {}
        : { submittedBy: original.submittedBy }),
      ...(original?.model === undefined ? {} : { model: original.model }),
      ...(original?.effort === undefined ? {} : { effort: original.effort }),
      ...(request.task.context === undefined
        ? {}
        : { context: request.task.context }),
    });
    await this.store.appendAudit(undefined, {
      type: "task_submitted",
      taskId: followUp.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        objective: followUp.objective,
        deferredFrom: request.task.id,
        conflictedPaths: paths,
      },
    });
    return followUp.id;
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
      // Same reason as the deciding path: a revision of an approved contract
      // has to be allowed to replace it, or the lease keeps describing the
      // narrower plan this task is no longer working to.
      ...(request.revising === true ? { replaceApproved: true } : {}),
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
  /**
   * Narrows a repository-wide holder to the estimate it was granted against.
   *
   * Called by the task that wants the room, not by the one holding it. The
   * holder's own narrowing runs on a poll, and an arrival is not willing to
   * wait for it — that gap, plus the arrival's own retry interval, was most
   * of why two agents on unrelated files still queued.
   *
   * Written under the same compare-and-swap every admission uses, against the
   * approvals observed a moment ago. A refused write means the picture moved
   * while this was being decided, and the caller keeps the claim it saw.
   *
   * Returns the narrowed plan to arbitrate against, or nothing when the claim
   * still stands.
   */
  private async narrowBlanketHolder(
    holder: ActivePlan,
    baseVersion: number,
  ): Promise<ActivePlan | undefined> {
    const leases = await this.store.listWorkLeases({ status: "active" });
    const held = leases.find(
      (candidate) => candidate.taskId === holder.taskId,
    );
    if (held === undefined || held.plan === undefined) {
      return undefined;
    }
    const frozen = freezePlanFromWorkingChanges(
      holder.plan,
      holder.plan.expectedFiles.map((path) => ({
        path,
        status: "modified" as const,
      })),
    );
    const admission = this.admissions.admit({
      plan: frozen,
      agentId: holder.agentId,
      baseRevision: held.baseRevision,
      baseVersion,
      // A narrowing of a claim that covered the repository cannot collide
      // with anything: everything it keeps, it already held.
      active: [],
      planRevision: (held.plan.admission.planRevision ?? 1) + 1,
    });
    if (!planAdmissionApproved(admission)) {
      return undefined;
    }
    const saved = await this.store.saveWorkLeasePlan({
      leaseId: held.id,
      submission: { plan: frozen, admission },
      // Everything else approved in this repository — the holder's own lease
      // excluded, since that is the one being rewritten.
      observedApprovedLeaseIds: leases
        .filter(
          (candidate) =>
            candidate.id !== held.id &&
            candidate.repositoryId === held.repositoryId &&
            candidate.plan !== undefined &&
            planAdmissionApproved(candidate.plan.admission),
        )
        .map((candidate) => candidate.id)
        .sort(),
      // The same legitimate rewrite the holder's own freeze performs: this is
      // narrower than what was granted, so nobody's decision is invalidated.
      replaceApproved: true,
    });
    if (saved.outcome !== "saved") {
      return undefined;
    }
    await this.store.appendAudit(undefined, {
      type: "blanket_claim_frozen",
      taskId: holder.taskId,
      data: {
        repositoryId: held.repositoryId,
        leaseId: held.id,
        files: frozen.expectedFiles,
        directories:
          frozen.claim?.kind === "frozen" ? frozen.claim.directories : [],
        // Says who asked, because this narrowing is not the holder noticing
        // anything — somebody else needed the room and took it.
        narrowedOnArrival: true,
      },
    });
    return { ...holder, plan: frozen };
  }

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
