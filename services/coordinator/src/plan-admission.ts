import {
  type AgentPlan,
  type ConflictAssessment,
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

  public admit(input: PlanAdmissionInput): PlanAdmission {
    const taskId = input.plan.taskId;
    const retryAfterMs = input.retryAfterMs ?? DEFAULT_PLAN_RETRY_MS;
    const shared = {
      taskId,
      planRevision: input.planRevision ?? 1,
      baseRevision: input.baseRevision,
      decidedAt: new Date().toISOString(),
    };
    const others = input.active.filter((entry) => entry.taskId !== taskId);

    const assessments = others
      .map((entry) => this.conflicts.assess(input.plan, entry.plan))
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
    const ownership = this.ownershipFor();
    for (const entry of others) {
      try {
        ownership.acquire(entry.plan, entry.agentId, input.baseVersion, {
          approvedResources: approvedSchemaResources(entry.plan),
        });
      } catch {
        // Two admitted plans can only collide here if one was admitted while
        // the other was invisible — a lapsed lease, say. Conflict assessment
        // above already covered the candidate against both, so seeding
        // continues rather than failing the admission on someone else's state.
      }
    }

    let grants: ResourceLease[];
    try {
      grants = ownership.acquire(input.plan, input.agentId, input.baseVersion, {
        approvedResources: approvedSchemaResources(input.plan),
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
