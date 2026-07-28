import {
  planAdmissionApproved,
  reducePlanScope,
  uniqueRepositoryPaths,
  type AgentPlan,
  type ConflictAssessment,
  type DeferredResource,
  type PlanAdmission,
  type ResourceLease,
  type TaskId,
} from "@coord/shared-types";

import { ConflictDetector } from "./conflict-detector.js";
import {
  OwnershipApprovalRequiredError,
  OwnershipConflictError,
  OwnershipService,
} from "./ownership-service.js";

/**
 * Arbitration of one plan against the work already running.
 *
 * The local coordinator answers this question inside its wave scheduler: it
 * holds every plan in memory, assesses them pairwise, and only then hands a
 * workspace to an agent. A remote worker has no such vantage point — it holds
 * one plan and knows nothing about the others — so the same question has to be
 * answerable from a single candidate plus the set of plans currently executing.
 *
 * That is all this is: the same {@link ConflictDetector} and
 * {@link OwnershipService} the local path uses, driven from one side instead of
 * from above. Nothing here re-implements conflict scoring or ownership modes.
 */

/** A plan that has already been admitted and is being executed. */
export interface ActivePlan {
  taskId: TaskId;
  agentId: string;
  plan: AgentPlan;
}

export interface PlanAdmissionInput {
  plan: AgentPlan;
  agentId: string;
  /** Canonical revision the plan was written against. */
  baseRevision: string;
  /** Canonical sequence, used as the ownership lease base. */
  baseVersion: number;
  active: readonly ActivePlan[];
  planRevision?: number;
  /** How long a deferred holder should wait before resubmitting. */
  retryAfterMs?: number;
  /**
   * Whether a plan that only partly collides may be admitted on the rest of
   * its declared resources. Defaults to on. Turning it off restores strict
   * all-or-nothing arbitration, which is what a follow-up task gets: splitting
   * an already-split task again is how a task could keep shedding scope
   * forever.
   */
  partialAdmission?: boolean;
}

/**
 * Long enough that a resubmission is not a busy-wait, short enough that a
 * worker picks up a freed slot well inside one lease period.
 */
export const DEFAULT_PLAN_RETRY_MS = 15_000;

/**
 * Resources a plan may claim in `approval_required` mode.
 *
 * Naming a schema in the plan is what makes the claim legitimate: the change
 * was declared to the coordinator up front rather than discovered mid-edit.
 * Shared by both scheduling paths so they grant ownership on identical terms.
 */
export function approvedSchemaResources(plan: AgentPlan): ReadonlySet<string> {
  return new Set(
    (plan.expectedSchemas ?? []).map((resource) => `schema\0${resource}`),
  );
}

/** Intent evidence is advisory; only structural evidence controls scheduling. */
export function structuralConflict(assessment: ConflictAssessment): boolean {
  return assessment.evidence.some(
    (entry) => entry.advisory !== true && entry.score > 0,
  );
}

function otherTask(assessment: ConflictAssessment, taskId: TaskId): TaskId {
  return assessment.taskIds.find((id) => id !== taskId) ?? taskId;
}

/**
 * The agent-facing half of a partial admission.
 *
 * It reaches the agent through the coordinator decision the worker sends
 * before execution, so a well-behaved agent simply never writes to these
 * files. The control plane does not rely on that: a changeset that touches a
 * deferred file is split apart rather than applied.
 */
export function deferralConstraints(
  deferred: readonly DeferredResource[],
): string[] {
  if (deferred.length === 0) {
    return [];
  }
  return [
    "Do not modify these deferred resources; they are owned by other " +
      `executing tasks and will be handled by a follow-up task: ${deferred
        .map((resource) => `${resource.resourceType}:${resource.resourceId}`)
        .join(", ")}`,
    ...deferred.map(
      (resource) =>
        `${resource.resourceType}:${resource.resourceId} — ${resource.reason}`,
    ),
  ];
}

export class PlanAdmissionController {
  public constructor(
    private readonly conflicts: ConflictDetector = new ConflictDetector(),
    /**
     * Ownership is evaluated from scratch on every admission rather than held
     * across calls: the durable set of active plans is the store's, and a
     * long-lived in-memory lease table would drift from it whenever a lease
     * lapsed or a control-plane process restarted.
     */
    private readonly ownershipFor: () => OwnershipService = () =>
      new OwnershipService(),
  ) {}

  /**
   * Decides one plan against the work already running.
   *
   * All-or-nothing first, because that is the answer that needs no
   * qualification. Only when the whole plan is refused is the finer question
   * asked: is *some* of it free right now? A plan that names five files and
   * collides on one has four files nobody is touching, and making the holder
   * wait for all five is throughput thrown away for no safety gained.
   */
  public admit(input: PlanAdmissionInput): PlanAdmission {
    const whole = this.decide(input.plan, input);
    if (planAdmissionApproved(whole) || input.partialAdmission === false) {
      return whole;
    }
    return this.admitPartially(input, whole) ?? whole;
  }

  /**
   * Admits the uncontested remainder of a plan, or nothing.
   *
   * The reduced plan is put through the same arbitration as any other plan
   * rather than being waved through: partial admission decides *what to ask*,
   * it never decides the answer. If the remainder is refused for any reason —
   * a symbol both plans still claim, a schema awaiting approval, dependency
   * impact that no resource removal can undo — the original all-or-nothing
   * answer stands.
   *
   * Only files are ever withheld. A withheld resource is only meaningful if
   * the control plane can hold a result to it, and a changeset is a set of
   * file patches: "this patch touches a file you were not granted" is
   * checkable, "this patch touches a symbol you were not granted" is not.
   */
  private admitPartially(
    input: PlanAdmissionInput,
    whole: PlanAdmission,
  ): PlanAdmission | undefined {
    const deferred = this.contestedFiles(input);
    if (deferred.length === 0) {
      return undefined;
    }
    const reduced = reducePlanScope(input.plan, deferred);
    // Nothing left to work on: the holder would burn an agent run to produce
    // an empty changeset, which is strictly worse than waiting its turn.
    if (reduced.expectedFiles.length === 0) {
      return undefined;
    }
    const partial = this.decide(reduced, input);
    if (!planAdmissionApproved(partial)) {
      return undefined;
    }
    const granted = reduced.expectedFiles.join(", ");
    return {
      ...partial,
      status: "approved_with_constraints",
      // Not blocked: this holder is executing. What is held up is named
      // per-resource in `deferredResources`, alongside who holds it.
      blockedBy: [],
      deferredResources: deferred,
      constraints: [...partial.constraints, ...deferralConstraints(deferred)],
      conflicts: [
        ...partial.conflicts,
        ...whole.conflicts.filter(structuralConflict),
      ],
      explanation:
        `Partially admitted: granted ${granted}; deferred ` +
        deferred
          .map(
            (resource) =>
              `${resource.resourceId} (held by ${resource.heldBy.join(", ")})`,
          )
          .join(", "),
    };
  }

  /**
   * Declared files that executing work is holding, with who holds each.
   *
   * Both halves of arbitration are asked, because they catch different things:
   * conflict scoring sees two plans naming the same file, ownership sees a
   * live lease on one. A file either of them names is contested.
   */
  private contestedFiles(input: PlanAdmissionInput): DeferredResource[] {
    const taskId = input.plan.taskId;
    const others = input.active.filter((entry) => entry.taskId !== taskId);
    const contested = new Map<
      string,
      { heldBy: Set<TaskId>; reasons: Set<string> }
    >();
    const note = (file: string, holder: TaskId, reason: string): void => {
      const entry = contested.get(file) ?? {
        heldBy: new Set<TaskId>(),
        reasons: new Set<string>(),
      };
      entry.heldBy.add(holder);
      entry.reasons.add(reason);
      contested.set(file, entry);
    };

    for (const entry of others) {
      const assessment = this.conflicts.assess(input.plan, entry.plan);
      if (assessment === undefined || !structuralConflict(assessment)) {
        continue;
      }
      for (const item of assessment.evidence) {
        if (item.advisory === true || item.kind !== "file_overlap") {
          continue;
        }
        for (const file of item.resources) {
          note(
            file,
            entry.taskId,
            `also declared by executing task ${entry.taskId}`,
          );
        }
      }
    }
    for (const lease of this.seededOwnership(input, others).blockersFor(
      input.plan,
    )) {
      if (lease.resourceType !== "file") {
        continue;
      }
      note(
        lease.resourceId,
        lease.taskId,
        `owned by ${lease.taskId} in ${lease.mode} mode until ${lease.expiresAt}`,
      );
    }

    const declared = new Set(uniqueRepositoryPaths(input.plan.expectedFiles));
    return [...contested]
      .filter(([file]) => declared.has(file))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, entry]): DeferredResource => ({
        resourceType: "file",
        resourceId: file,
        heldBy: [...entry.heldBy].sort(),
        reason: [...entry.reasons].sort().join("; "),
      }));
  }

  /**
   * An ownership view holding every executing plan's leases.
   *
   * Seeding failures are swallowed for the same reason as in {@link decide}:
   * one executing plan colliding with another is someone else's problem, and
   * the candidate is arbitrated against whatever seeded successfully.
   */
  private seededOwnership(
    input: PlanAdmissionInput,
    others: readonly ActivePlan[],
  ): OwnershipService {
    const ownership = this.ownershipFor();
    for (const entry of others) {
      try {
        ownership.acquire(entry.plan, entry.agentId, input.baseVersion, {
          approvedResources: approvedSchemaResources(entry.plan),
        });
      } catch {
        // See decide(): a collision between two already-admitted plans is not
        // this candidate's to resolve.
      }
    }
    return ownership;
  }

  private decide(plan: AgentPlan, input: PlanAdmissionInput): PlanAdmission {
    const taskId = plan.taskId;
    const retryAfterMs = input.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS;
    const shared = {
      taskId,
      planRevision: input.planRevision ?? 1,
      baseRevision: input.baseRevision,
      decidedAt: new Date().toISOString(),
    };
    const others = input.active.filter((entry) => entry.taskId !== taskId);

    const assessments = others
      .map((entry) => this.conflicts.assess(plan, entry.plan))
      .filter((entry): entry is ConflictAssessment => entry !== undefined);
    const structural = assessments.filter(structuralConflict);
    const blocking = structural.filter(
      (assessment) => assessment.disposition === "block",
    );

    // A "block" disposition is the detector saying the two plans are not
    // separable by ordering. Sequencing would just move the collision later,
    // so the plan is refused outright and the holder must plan again.
    if (blocking.length > 0) {
      return {
        ...shared,
        status: "blocked",
        ownershipGrants: [],
        constraints: [
          "Plan again with a narrower scope, or wait for the conflicting task to settle",
        ],
        blockedBy: blocking.map((assessment) => otherTask(assessment, taskId)),
        conflicts: blocking,
        explanation:
          "Plan collides with executing work beyond the sequencing threshold: " +
          blocking
            .map(
              (assessment) =>
                `${otherTask(assessment, taskId)} (${assessment.score})`,
            )
            .join(", "),
        retryAfterMs,
      };
    }

    if (structural.length > 0) {
      return {
        ...shared,
        status: "sequenced",
        ownershipGrants: [],
        constraints: [
          "Start from canonical state after the blocking tasks integrate",
        ],
        blockedBy: structural.map((assessment) => otherTask(assessment, taskId)),
        conflicts: structural,
        explanation:
          "Sequenced behind executing work on the same resources: " +
          structural
            .map(
              (assessment) =>
                `${otherTask(assessment, taskId)} — ${assessment.explanation}`,
            )
            .join("; "),
        retryAfterMs,
      };
    }

    // Ownership is the second, finer check. Conflict scoring answers "should
    // these run together"; ownership answers "may this exact resource be held
    // in this mode", which is where shared files and intent-mode resources
    // stop being conflicts at all.
    //
    // Two admitted plans can only collide while seeding if one was admitted
    // while the other was invisible — a lapsed lease, say. Conflict assessment
    // above already covered the candidate against both, so seeding continues
    // rather than failing the admission on someone else's state.
    const ownership = this.seededOwnership(input, others);

    let grants: ResourceLease[];
    try {
      grants = ownership.acquire(plan, input.agentId, input.baseVersion, {
        approvedResources: approvedSchemaResources(plan),
      });
    } catch (error) {
      if (error instanceof OwnershipConflictError) {
        const blocker = error.blockingLease.taskId;
        return {
          ...shared,
          status: "sequenced",
          ownershipGrants: [],
          constraints: [
            "Start from canonical state after the blocking tasks integrate",
          ],
          blockedBy: [blocker],
          conflicts: assessments,
          explanation: `Ownership is held by ${blocker}: ${error.message}`,
          retryAfterMs,
        };
      }
      if (error instanceof OwnershipApprovalRequiredError) {
        return {
          ...shared,
          status: "blocked",
          ownershipGrants: [],
          constraints: ["Human approval is required before this plan can run"],
          blockedBy: [],
          conflicts: assessments,
          explanation: error.message,
          retryAfterMs,
        };
      }
      throw error;
    }

    // Advisory evidence never blocks, but the holder is told about it: an
    // intent collision the detector cannot prove is exactly the case a human
    // reading the audit trail wants to see.
    const advisory = assessments.filter(
      (assessment) => !structuralConflict(assessment),
    );
    const constraints = advisory.map(
      (assessment) =>
        `Advisory overlap with ${otherTask(assessment, taskId)}: ` +
        assessment.explanation,
    );
    return {
      ...shared,
      status: advisory.length > 0 ? "approved_with_constraints" : "approved",
      ownershipGrants: grants,
      constraints,
      blockedBy: [],
      conflicts: advisory,
      explanation:
        advisory.length > 0
          ? "Approved; advisory overlap with executing work was recorded"
          : "Approved: no structural conflict with executing work, ownership granted",
    };
  }
}
