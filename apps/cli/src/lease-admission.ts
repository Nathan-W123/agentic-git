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
  askBlanketHolderOnce,
  blanketHolderSession,
  blanketPlan,
  contestedPlanResources,
  declaredPlanFromClaim,
  deferredScopeObjective,
  freezePlanFromWorkingChanges,
  isDeferredScopeFollowUp,
  usableRepositoryPath,
  type ActivePlan,
  type BlanketClaimRequest,
  type BlanketFreezeRequest,
  type DeferredScopeRequest,
  type HolderDeclaration,
  type PlanAdmissionRequest,
  type SalvagedConflictRequest,
  type PlanAuthority,
  type PlanAuthorityDecision,
  type WaitingWork,
  type WaitingWorkRequest,
} from "@coord/coordinator";
import type { CoordinationStore, WorkLease } from "@coord/persistence";
import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  GitWorktreeWorkspaceManager,
  type TaskWorkspace,
  type WorkspaceManager,
} from "@coord/workspace-manager";
import {
  claimOccupiesPath,
  isBlanketClaim,
  normalizeRepositoryPath,
  planAdmissionApproved,
  planAdmissionPartial,
  reducePlanScope,
  uniqueRepositoryPaths,
  type AgentPlan,
  type CanonicalVersion,
  type FilePatchStatus,
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
 * The answer, or nothing once the deadline passes.
 *
 * The ask is not cancelled — there is no way to un-ask an agent, and the
 * coordinator resumes it either way — only stopped being waited for, and a
 * late rejection is absorbed so it cannot surface as an unhandled rejection
 * after the decision that wanted it has been made.
 */
async function answerWithin<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * What a narrowing driven by an arrival adds to its record.
 *
 * Says who asked, because this is not the holder noticing anything — somebody
 * else needed the room and took it — and what the arrival was given off the
 * holder's estimate, which is what makes that estimate's slack measurable
 * after the fact rather than only in a benchmark. Empty for the holder's own
 * poll, which is nobody's arrival.
 */
function arrivalRecord(
  request: BlanketFreezeRequest,
  observedFiles: number,
): Record<string, unknown> {
  if (request.arrival === undefined) {
    return {};
  }
  return {
    narrowedOnArrival: true,
    // Zero is a real answer — a holder that has not written yet — and worth
    // telling apart on the record from a read that failed, which never
    // reaches here at all.
    observedFiles,
    releasedFiles: [...request.arrival.releasedFiles],
  };
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
  /** Reads a holder's worktree, to narrow its claim to what it is editing. */
  private readonly workspaces: WorkspaceManager;
  /** When each task was first told to wait, for the bound below. */
  private readonly waitingSince = new Map<TaskId, number>();
  /**
   * Holders that have already been asked to describe themselves.
   *
   * One ask per holder per contention episode, not one per arrival and not
   * one per retry: a holder joined by three tasks must not be paused three
   * times. Added *before* the ask, so the recursive `stale` retry below and
   * any re-entry cannot produce a second one, and never cleared — an agent
   * that has said where it is going has said it.
   */
  private readonly asked = new Set<TaskId>();
  /** See the constructor option of the same name. */
  private readonly blanketAskTimeoutMs: number;

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
    /**
     * How a holder's in-progress edits are read when its repository-wide claim
     * has to be narrowed for somebody else.
     *
     * Injectable so a test can hand over a stub, and so a host that already
     * has one does not build a second. The default reads worktrees through the
     * same git client every other caller uses.
     */
    workspaces?: WorkspaceManager;
    /**
     * How long an arriving task will wait for a blanket holder to say what
     * the rest of its work needs, before narrowing it the old way instead.
     *
     * The ask reaches a live agent process through the coordinator, and this
     * is the one place it is on the critical path of somebody else's
     * admission decision. Bounded at the retry interval, which is the honest
     * comparison: an arrival never waits longer for an answer than it would
     * have waited to simply ask again. On the deadline the claim is frozen
     * exactly as it is today and the arrival takes its retry — the behaviour
     * that shipped, never a grant.
     */
    blanketAskTimeoutMs?: number;
  }) {
    this.store = options.store;
    this.leaseIdForTask = options.leaseIdForTask;
    this.repositories = options.repositories ?? new RepositoryService();
    this.intelligence =
      options.intelligence ?? new CodeIntelligenceService(this.repositories);
    this.admissions = options.admissions ?? new PlanAdmissionController();
    this.maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000;
    this.blanketClaims = options.blanketClaims ?? true;
    this.workspaces =
      options.workspaces ??
      new GitWorktreeWorkspaceManager(this.repositories.getGitClient());
    this.blanketAskTimeoutMs =
      options.blanketAskTimeoutMs ?? DEFAULT_PLAN_RETRY_MS;
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
        request.baseVersion,
        request.repository,
        // What this arrival is asking for. A file the holder only guessed at
        // and has never written to is released to it here rather than held
        // for the rest of the holder's run — see `narrowBlanketHolder`.
        uniqueRepositoryPaths(request.plan.expectedFiles),
        request.projectId,
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
    input: BlanketFreezeRequest,
  ): Promise<AgentPlan | undefined> {
    if (!isBlanketClaim(input.plan)) {
      return undefined;
    }
    // Reap anything whose holder stopped heartbeating first: a lapsed lease is
    // not work in progress, and freezing one would rewrite a dead task's plan.
    await this.store.expireWorkLeases(new Date().toISOString());
    const leaseId = this.leaseIdForTask.get(input.task.id);
    const lease =
      leaseId === undefined
        ? // Not a task this run is executing, which is the arrival's case:
          // the holder belongs to another run, and the lease table is the
          // only thing the two of them can both see. Narrowing it from here
          // is the operation the arrival path has always performed — the same
          // compare-and-swap, the same `replaceApproved`, and never wider
          // than what the holder already had.
          (
            await this.store.listWorkLeases({ status: "active" })
          ).find((candidate) => candidate.taskId === input.task.id)
        : await this.store.getWorkLease(leaseId);
    if (lease === undefined || lease.status !== "active") {
      return undefined;
    }
    // What this holder actually holds, which is not necessarily what the
    // caller thinks it holds.
    //
    // The caller is a poll on a run that has been executing for a while, and
    // the plan it passes is the one it had in memory when the claim was
    // granted. Meanwhile an arrival can have narrowed the same claim off the
    // lease table — and then a freeze against the caller's copy would *widen*
    // the holder back to its original estimate, over ground the arrival has
    // since been granted. Two tasks would hold one file and neither side
    // would say so.
    //
    // So the durable record decides, in both directions: a claim already
    // converted is answered with what it became, and one still whole may be
    // narrowed but never re-widened past what it currently names.
    const stored = lease.plan?.plan;
    if (
      stored !== undefined &&
      stored.taskId === input.plan.taskId &&
      !isBlanketClaim(stored)
    ) {
      // Already an ordinary plan. Answering with it rather than `undefined`
      // is what lets the caller adopt the truth — a coordinator whose tick
      // gets nothing back goes on believing it holds the repository, and goes
      // on telling its agent so.
      return stored;
    }
    // Files this holder has already handed back of its own accord are not
    // ground to freeze on either: somebody may have been granted them since,
    // and the caller's copy of the plan predates the release. The estimate
    // gets the same treatment as the plan, because the freeze narrows to the
    // estimate whenever the holder has written nothing — a stale estimate
    // re-widens a claim exactly as effectively as a stale plan does.
    const givenBack = new Set(
      stored?.claim?.kind === "blanket" ? (stored.claim.released ?? []) : [],
    );
    const stillHeld = (file: string): boolean => !givenBack.has(file);
    const request: BlanketFreezeRequest =
      givenBack.size === 0
        ? input
        : {
            ...input,
            plan: {
              ...input.plan,
              expectedFiles: uniqueRepositoryPaths(
                input.plan.expectedFiles,
              ).filter((file) => stillHeld(file)),
            },
            estimatedFiles: uniqueRepositoryPaths(input.estimatedFiles).filter(
              (file) => stillHeld(file),
            ),
          };
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
    // Asked before the worktree is read, and asked once.
    //
    // This is the ask that makes the difference between the arrival running
    // and the arrival waiting: a freeze carries no symbols — freezing never
    // adds any — and exempts every file it names, so partial admission could
    // never fire between the first and second task in a repository at all.
    // Here the holder is paused, asked what the rest of its work needs, and
    // resumed, and what it says becomes an ordinary plan.
    //
    // The `asked` entry goes in before the call, not after, so the recursive
    // retry below cannot produce a second ask. It is not the whole bound
    // though — it is per authority instance, and a run builds its own — so
    // concurrent arrivals are held to one ask by the holder registry instead,
    // which both callers now go through. This set is what stops the same
    // authority asking twice; the registry is what stops two of them.
    let declaration: HolderDeclaration | undefined;
    if (request.declare !== undefined && !this.asked.has(request.task.id)) {
      this.asked.add(request.task.id);
      try {
        declaration = await request.declare();
      } catch {
        // Every failure falls back to today's behaviour. Degrade to a wait,
        // never to a wrong grant.
        declaration = undefined;
      }
    }
    const changes = await request.observe();
    if (declaration !== undefined) {
      const declared = await this.declareBlanketClaim(
        request,
        lease,
        others,
        approvedLeaseIds,
        declaration,
        changes,
      );
      if (declared !== undefined) {
        return declared;
      }
      // Anything the answer could not buy falls through to the plain freeze
      // below, which is exactly what would have happened without it.
    }
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
        ...arrivalRecord(request, changes.length),
      },
    });
    return frozen;
  }

  /**
   * Turns a repository-wide claim into an ordinary plan carrying what its
   * holder just said it needs, or nothing when that cannot be done safely.
   *
   * The footprint is the union of the answer and the observation, never the
   * answer alone — {@link declaredPlanFromClaim} is where that union is made,
   * and the files the holder was seen in but did not mention are recorded on
   * the converted claim as `held`, whole.
   *
   * Arbitrated against the other approved holders rather than against nothing.
   * The plain freeze can pass `active: []` because a narrowing of a claim that
   * covered the repository keeps only what it already held; this is not purely
   * a narrowing — the answer can name a file the arrival has already been
   * granted — so it has to be decided like any other plan. An answer-only file
   * that collides is dropped and the rest re-decided; a collision on a file
   * this holder has already *written in* abandons the conversion altogether,
   * because an observed file is already its work and must never be traded away.
   */
  private async declareBlanketClaim(
    request: BlanketFreezeRequest,
    lease: WorkLease,
    others: readonly WorkLease[],
    approvedLeaseIds: readonly string[],
    declaration: HolderDeclaration,
    observed: ReadonlyArray<{ path: string }>,
  ): Promise<AgentPlan | undefined> {
    const active = await this.approvedPlansAmong(others);
    const occupiedElsewhere = (file: string): boolean =>
      active.some(
        (entry) =>
          claimOccupiesPath(entry.plan, file) ||
          uniqueRepositoryPaths(entry.plan.expectedFiles).includes(file),
      );
    const touched = uniqueRepositoryPaths(
      observed.map((change) => change.path).filter(usableRepositoryPath),
    );
    if (touched.some((file) => occupiedElsewhere(file))) {
      // Somebody else has been granted a file this holder is already writing
      // in. Nothing about that is fixed by narrowing it further, and trading
      // the file away would overwrite work already done. The freeze keeps it.
      return undefined;
    }
    // Normalized only after the answer has been proved usable: an absolute
    // path or one escaping the repository is not something to resolve against
    // another holder's files, it is something to drop. `normalizeRepositoryPath`
    // throws on both, which is right for a plan and wrong for a model's answer.
    const kept = declaration.files
      .filter(usableRepositoryPath)
      .filter((file) => !occupiedElsewhere(normalizeRepositoryPath(file)));
    const converted = declaredPlanFromClaim(
      request.plan,
      { files: kept, symbols: declaration.symbols },
      observed,
    );
    if (converted === undefined) {
      // No usable file, or no usable symbol. A converted plan with no symbols
      // is worse than the freeze it would replace: nobody can be admitted
      // around a holder that declared none, and the holder would have given up
      // the directory latitude a freeze grants it for nothing.
      return undefined;
    }
    const admission: PlanAdmission = this.admissions.admit({
      plan: converted,
      agentId: request.task.agentId,
      baseRevision: request.baseVersion.revision,
      baseVersion: request.baseVersion.sequence,
      active,
      planRevision: request.planRevision + 1,
      // All or nothing: a partially admitted holder would leave a file it is
      // already writing in outside the plan its changeset is validated against.
      partialAdmission: false,
    });
    if (!planAdmissionApproved(admission)) {
      return undefined;
    }
    const saved = await this.store.saveWorkLeasePlan({
      leaseId: lease.id,
      submission: { plan: converted, admission },
      observedApprovedLeaseIds: [...approvedLeaseIds],
      // The same legitimate rewrite of an approved contract the freeze
      // performs, and narrower in the way that matters: every file this keeps
      // it already held under a claim that covered the repository.
      replaceApproved: true,
    });
    if (saved.outcome !== "saved") {
      // A refused write re-reads rather than reusing this decision, and the
      // `asked` entry set before the ask is what keeps that recursion from
      // asking a second time.
      return undefined;
    }
    const held =
      converted.claim?.kind === "declared" ? converted.claim.held : [];
    await this.store.appendAudit(undefined, {
      type: "blanket_claim_declared",
      taskId: request.task.id,
      data: {
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        repositoryId: request.repository.id,
        leaseId: lease.id,
        files: converted.expectedFiles,
        symbols: converted.expectedSymbols,
        held,
        // How much of the footprint came from the worktree rather than from
        // the answer. A holder that names everything it has touched reads as
        // zero here, which is the healthy shape.
        observedFiles: touched.length,
        arrivedTasks: others.map((candidate) => candidate.taskId).sort(),
        ...(request.arrival === undefined
          ? {}
          : {
              narrowedOnArrival: true,
              releasedFiles: [...request.arrival.releasedFiles],
            }),
      },
    });
    return converted;
  }

  /** The approved plans among a set of leases, as arbitration reads them. */
  private async approvedPlansAmong(
    leases: readonly WorkLease[],
  ): Promise<ActivePlan[]> {
    const approved = leases.filter(
      (candidate) =>
        candidate.plan !== undefined &&
        planAdmissionApproved(candidate.plan.admission),
    );
    if (approved.length === 0) {
      return [];
    }
    const tasks = await this.store.listSubmittedTasks({});
    const agentFor = new Map(tasks.map((task) => [task.id, task.agentId]));
    return approved.map(
      (candidate): ActivePlan => ({
        taskId: candidate.taskId,
        agentId: agentFor.get(candidate.taskId) ?? candidate.workerId,
        plan: (candidate.plan as { plan: AgentPlan }).plan,
      }),
    );
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
  /**
   * A holder's in-progress edits, read from the worktree it is working in.
   *
   * The holder is another process — a worker daemon, or an earlier run of this
   * one — so there is no live workspace handle to borrow. The row written when
   * its task started is the way across: `findWorkspaceByTaskId` is recorded
   * for exactly this, and the worktree it names is a directory on this host
   * whether the agent runs there or inside a container, because a docker
   * workspace masks only the container's own `.git` pointer.
   *
   * The base revision must be the one the workspace was created against, never
   * the arriving plan's. A diff taken against the wrong base is not a weaker
   * observation, it is a fictional one.
   *
   * Answers `undefined` for every way the reading can fail — no recorded
   * workspace, a manager that cannot list, a `git` call that throws — because
   * the caller has to tell "this holder has written nothing" apart from "we
   * could not find out", and only one of those is safe to narrow on.
   */
  private async observeHolder(
    holderTaskId: TaskId,
    repository: CanonicalRepository,
  ): Promise<Array<{ path: string; status: FilePatchStatus }> | undefined> {
    const list = this.workspaces.listWorkingChanges?.bind(this.workspaces);
    if (list === undefined) {
      return undefined;
    }
    const stored = await this.store
      .findWorkspaceByTaskId(holderTaskId)
      .catch(() => undefined);
    if (stored === undefined) {
      return undefined;
    }
    const workspace: TaskWorkspace = {
      id: stored.id,
      taskId: stored.taskId,
      path: stored.path,
      rootPath: stored.path,
      repository,
      baseVersion: {
        sequence: 0,
        revision: stored.baseRevision,
        branch: repository.branch,
        createdAt: stored.createdAt,
      },
      isolation: stored.isolation === "docker" ? "docker" : "git-worktree",
      createdAt: stored.createdAt,
    };
    try {
      return await list(workspace);
    } catch {
      return undefined;
    }
  }

  private async narrowBlanketHolder(
    holder: ActivePlan,
    baseVersion: CanonicalVersion,
    repository: CanonicalRepository,
    /**
     * The paths the arriving plan wants, normalized.
     *
     * Only these are candidates for release. A file nobody is asking for
     * stays with the holder however cold it looks: releasing on the holder's
     * idleness alone would give away ground for free and gain nobody
     * anything.
     */
    wanted: readonly string[] = [],
    /** The arrival's project, so a narrowing it caused is recorded under it. */
    projectId?: string,
  ): Promise<ActivePlan | undefined> {
    const leases = await this.store.listWorkLeases({ status: "active" });
    const held = leases.find(
      (candidate) => candidate.taskId === holder.taskId,
    );
    if (held === undefined || held.plan === undefined) {
      return undefined;
    }
    // What the holder is provably editing, not what its objective read like.
    //
    // This fed `expectedFiles` — the lexical scope estimate a blanket claim
    // carries — back in as though it were an observation. That is a guess
    // about a task that never planned, and narrowing to a guess is how an
    // arrival came to be granted a file the holder already had open: a
    // modified-but-unestimated path is not in `expectedFiles`, and for a
    // frozen claim `claimOccupiesPath` reads `expectedFiles` alone, so the
    // file was simply free.
    //
    // Reading the worktree is monotone beside it rather than instead of it:
    // `freezePlanFromWorkingChanges` unions the observed paths with the
    // estimate, so no path an arrival could be granted before this change is
    // withheld by it — only paths the holder is demonstrably in are added.
    const observed = await this.observeHolder(holder.taskId, repository);
    if (observed === undefined) {
      // A holder whose edits cannot be read is a holder whose claim cannot be
      // narrowed honestly, and every `catch` in this path would otherwise
      // spell "has written nothing" — which is exactly the hole above,
      // reopened by an unrelated `git` failure. The arrival is not stranded:
      // it takes the sequenced answer below, the force-admit bound still
      // applies, and the holder's own poll narrows the claim from a live
      // workspace handle within its next tick.
      return undefined;
    }
    // What the holder guessed at, is not in, and somebody else now needs.
    //
    // A blanket claim is frozen to its estimate unioned with what the holder
    // is observed editing, and the estimate is mostly slack: measured against
    // real commits in this repository, nine of every ten files it locks are
    // never opened. Holding them costs the arrival up to `maxWaitMs` and buys
    // the holder nothing.
    //
    // Three conditions, all necessary. The path must be one the arrival is
    // actually asking for — ground nobody wants is not worth taking off a
    // holder. It must be absent from the worktree read, because a file the
    // holder has written to is a file it is in. And the holder must have
    // written *something*, since presence is evidence of presence and never
    // of absence: a holder that has produced nothing yet has told us nothing
    // about where it is going, and its estimate is the only statement it has
    // made.
    //
    // The cost is the one `claimOccupiesPath` already accepts for a freeze's
    // directories: a holder that later reaches into a released file is
    // refused when it widens, and that task fails. This makes that trade on
    // the same terms — never for a file the holder has touched, and never for
    // one nobody else asked for — rather than inventing a new one.
    const dirty = new Set(
      observed.map((change) => normalizeRepositoryPath(change.path)),
    );
    const released =
      observed.length === 0
        ? []
        : uniqueRepositoryPaths(holder.plan.expectedFiles).filter(
            (path) => wanted.includes(path) && !dirty.has(path),
          );
    const kept =
      released.length === 0
        ? holder.plan
        : {
            ...holder.plan,
            expectedFiles: holder.plan.expectedFiles.filter(
              (path) => !released.includes(normalizeRepositoryPath(path)),
            ),
          };
    // Asked, where the holder is reachable — and it is the arrival that asks.
    //
    // This used to be two narrowing paths that could not both be right. The
    // holder's own ten-second poll carried the ask; the arrival narrowed the
    // claim itself, synchronously, with no way to reach a session — and an
    // arrival decides off the lease table in single-digit milliseconds, so it
    // always got there first and the holder was never asked at all. The
    // measured run asked nobody and sequenced the arrival nine milliseconds
    // in, nine seconds before the tick that would have asked.
    //
    // So there is one narrowing path, and it goes through the freeze that
    // already contains the ask: the union with `observe()`, the one-ask bound
    // shared with the poll, and every fallback. What stays here is what only
    // an arrival knows — which of the holder's guesses somebody is actually
    // asking for — and that is already off `kept` by this point.
    const asking = blanketHolderSession(holder.taskId, held.repositoryId);
    if (asking !== undefined) {
      const declared = await this.freezeBlanketClaim({
        task: asking.task,
        plan: kept,
        planRevision: held.plan.admission.planRevision ?? 1,
        repository,
        ...(projectId === undefined ? {} : { projectId }),
        // The holder's own base, never the arrival's: a diff taken against
        // the wrong base is not a weaker observation, it is a fictional one.
        baseVersion: { ...baseVersion, revision: held.baseRevision },
        estimatedFiles: uniqueRepositoryPaths(kept.expectedFiles),
        // Re-read at the moment of the freeze rather than reusing the read
        // above, and a read that fails throws rather than answering "nothing
        // written" — which is the difference between narrowing a holder and
        // erasing it.
        observe: async () => {
          const fresh = await this.observeHolder(holder.taskId, repository);
          if (fresh === undefined) {
            throw new Error(
              `The working changes of task ${holder.taskId} could not be read`,
            );
          }
          // Field by field, so no `ranges` this manager may learn to report
          // can reach the freeze: a claim narrowed on somebody else's arrival
          // holds its files whole.
          return fresh.map((change) => ({
            path: change.path,
            status: change.status,
          }));
        },
        // Bounded, because this one is on the critical path of a decision.
        // Past the deadline the ask is abandoned — it is not cancelled, the
        // holder is resumed by the coordinator either way — and the claim is
        // frozen exactly as it is below. The arrival then waits a retry,
        // which is the behaviour that ships today.
        // Through the registry, not straight at the session. `this.asked`
        // cannot bound this: an authority is built per run, so two arrivals in
        // one worker hold two of them while the holder registry is one map —
        // measured as three concurrent pauses and replans against one live
        // session, which a vendor CLI refuses. The registry keys the ask to the
        // holder, so simultaneous arrivals share one pause and one answer.
        declare: async () =>
          await answerWithin(
            askBlanketHolderOnce(asking),
            this.blanketAskTimeoutMs,
          ),
        arrival: { releasedFiles: released },
      }).catch(() => undefined);
      if (declared !== undefined && !isBlanketClaim(declared)) {
        return { ...holder, plan: declared };
      }
      // Anything the ask could not buy falls through to the freeze below,
      // which is exactly what would have happened without it.
    }
    const frozen = freezePlanFromWorkingChanges(kept, [
      ...kept.expectedFiles.map((path) => ({
        path,
        status: "modified" as const,
      })),
      // Field by field, so no `ranges` this manager may learn to report can
      // reach the freeze. A claim frozen on somebody else's arrival holds its
      // files whole — see `admitWithinFiles`, which no longer reads a watched
      // range for a grant.
      ...observed.map((change) => ({
        path: change.path,
        status: change.status,
      })),
    ]);
    const admission = this.admissions.admit({
      plan: frozen,
      agentId: holder.agentId,
      baseRevision: held.baseRevision,
      baseVersion: baseVersion.sequence,
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
        // How much of the freeze came from the worktree rather than from the
        // objective's estimate. Zero is a real answer — a holder that has not
        // written yet — and worth telling apart on the record from a read
        // that failed, which does not reach here at all.
        observedFiles: observed.length,
        // Estimated ground handed to the arrival because the holder was never
        // in it. The pair with `files` is what makes the estimate's slack
        // measurable after the fact rather than only in a benchmark.
        releasedFiles: released,
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
