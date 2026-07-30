import {
  completeAgentPlan,
  planAdmissionApproved,
  planGroundingConfidence,
  planResourceKey,
  reducePlanScope,
  uniqueRepositoryPaths,
  type AgentPlan,
  type ConflictAssessment,
  type ConflictEvidence,
  type DeferredResource,
  type PlanAdmission,
  type PlanResourceRef,
  type ResourceLease,
  type ResourceType,
  type TaskId,
} from "@coord/shared-types";

import type { NamedRange } from "./hunks.js";

import { ConflictDetector, relatedObjectives } from "./conflict-detector.js";
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
  /**
   * Resources the repository index attributes to one file.
   *
   * Plans reaching admission have been enriched: naming a file makes the plan
   * claim that file's symbols, APIs and schemas too. Withholding the file
   * without withholding those claims would leave the reduced plan asking for
   * the very things the other holder owns, and partial admission would almost
   * never apply. Supplying this lets a withheld file take its own derived
   * claims with it — and only its own: a symbol that also lives in a granted
   * file stays claimed, because the holder really may still edit it.
   */
  resourcesInFile?: (file: string) => readonly PlanResourceRef[];
  /**
   * Where each symbol lives in one file, or `undefined` when that file cannot
   * be parsed.
   *
   * Supplying this is what lets a *symbol* be withheld while the file holding
   * it is granted. Without it, a withheld symbol would be an instruction with
   * nothing behind it: the result is a set of file patches, and only line
   * positions make "did this patch touch that symbol" a question with an
   * answer. A single unreadable file among those being granted withdraws the
   * option entirely — half an answer is not one.
   */
  symbolRangesInFile?: (file: string) => readonly NamedRange[] | undefined;
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

/** Every resource a plan claims, other than the files themselves. */
function declaredResources(plan: AgentPlan): PlanResourceRef[] {
  const complete = completeAgentPlan(plan);
  const refs = (
    resourceType: PlanResourceRef["resourceType"],
    ids: readonly string[],
  ): PlanResourceRef[] =>
    ids.map((resourceId) => ({ resourceType, resourceId }));
  return [
    ...refs("symbol", complete.expectedSymbols),
    ...refs("api", complete.expectedApis),
    ...refs("schema", complete.expectedSchemas),
    ...refs("configuration", complete.expectedConfigKeys),
    ...refs("test", complete.expectedTests),
    ...refs("service", complete.expectedServices),
  ];
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
    // A plan whose declarations verification could not connect to the
    // repository at all has no trustworthy line to split along: granting
    // "the uncontested part" of a fiction grants an unknown.
    if (planGroundingConfidence(input.plan) === "ungrounded") {
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
   * Files are withheld first, because a file can always be held to: the result
   * is a set of file patches, and a patch on a file that was not granted is
   * refused on its path alone. Only when dropping the contested files is not
   * enough — a symbol both plans still claim, typically — is the finer
   * withholding tried, and only where the index can say which lines that
   * symbol occupies in every file being granted. Where it cannot, the plan
   * waits, because an instruction the control plane cannot check is not one.
   *
   * The cost is one the repository parallelism bound already accepts. This
   * turns "the second plan waits" into "the second plan runs concurrently", so
   * the two now race to integrate — and where the advance turns out to be
   * disjoint from the loser's work, the loser is replayed rather than
   * discarded. It is only ever reached where concurrent leases are enabled:
   * with parallelism of one, no two plans are active in a repository at once
   * and nothing here can fire.
   */
  private admitPartially(
    input: PlanAdmissionInput,
    whole: PlanAdmission,
  ): PlanAdmission | undefined {
    const contested = this.contestedFiles(input);
    // No contested file is not the end of it: what collides may be finer than
    // a file, and often is — two plans naming one symbol in a file only one of
    // them declared is exactly what ownership exists to catch.
    let deferred =
      contested.length === 0
        ? []
        : [
            ...contested,
            ...this.derivedFrom(input, contested),
            ...this.carriedSymbols(input, contested),
          ];
    let reduced =
      deferred.length === 0 ? input.plan : reducePlanScope(input.plan, deferred);
    // Nothing left to work on: the holder would burn an agent run to produce
    // an empty changeset, which is strictly worse than waiting its turn.
    if (reduced.expectedFiles.length === 0) {
      return undefined;
    }
    let partial = deferred.length === 0 ? whole : this.decide(reduced, input);

    // Dropping the contested files was not enough, or there were none to drop.
    // Withholding a symbol is only offered when every file still being granted
    // can be read closely enough to tell whether a patch reached into it.
    if (!planAdmissionApproved(partial)) {
      const symbols = this.contestedSymbols(input, reduced);
      if (symbols.length === 0) {
        return undefined;
      }
      deferred = [...deferred, ...symbols];
      reduced = reducePlanScope(input.plan, deferred);
      if (reduced.expectedFiles.length === 0) {
        return undefined;
      }
      partial = this.decide(reduced, input);
    }
    if (!planAdmissionApproved(partial) || deferred.length === 0) {
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
   * Claims the plan only carries because of a file being withheld.
   *
   * A resource that also belongs to a granted file is not returned: the holder
   * keeps working in that file, so it keeps the claim. What is returned is
   * exactly the set no granted file accounts for, which is what makes
   * withholding it enforceable — no patch that reaches canonical can be in a
   * file these live in.
   */
  private derivedFrom(
    input: PlanAdmissionInput,
    contested: readonly DeferredResource[],
  ): DeferredResource[] {
    const locate = input.resourcesInFile;
    if (locate === undefined) {
      return [];
    }
    const withheld = new Set(contested.map((entry) => entry.resourceId));
    const retained = new Set(
      input.plan.expectedFiles
        .filter((file) => !withheld.has(file))
        .flatMap((file) => locate(file))
        .map((resource) =>
          planResourceKey(resource.resourceType, resource.resourceId),
        ),
    );
    const claimed = new Set(
      declaredResources(input.plan).map((resource) =>
        planResourceKey(resource.resourceType, resource.resourceId),
      ),
    );

    const derived = new Map<string, DeferredResource>();
    for (const file of contested) {
      for (const resource of locate(file.resourceId)) {
        const key = planResourceKey(
          resource.resourceType,
          resource.resourceId,
        );
        if (retained.has(key) || !claimed.has(key) || derived.has(key)) {
          continue;
        }
        derived.set(key, {
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          heldBy: file.heldBy,
          reason:
            `claimed only through the deferred file ${file.resourceId}`,
        });
      }
    }
    return [...derived.values()].sort((left, right) =>
      `${left.resourceType}:${left.resourceId}`.localeCompare(
        `${right.resourceType}:${right.resourceId}`,
      ),
    );
  }

  /**
   * Declared symbols whose contest exists only through grounding, withheld
   * alongside the files that made them contested.
   *
   * A hallucinated plan's symbol claim (`calculateTotal`, grounded to
   * `orderTotal`) collides through its referent, and the ordinary
   * symbol-withholding stage cannot touch it: that stage requires the
   * withheld symbol to be locatable in a granted file, and a misname is
   * locatable nowhere. But when the referent is provably absent from every
   * file still being granted — the granted files all parse, and none of them
   * declares it — no patch this plan is allowed to produce can reach the real
   * symbol's definition, so withholding the misnamed declaration is sound:
   * reduction strips the declaration and its referents together, and the
   * remainder genuinely stops claiming the contested code. A patch could
   * still *introduce* a fresh definition under the withheld name in a granted
   * file; that is new code, not an edit to what the other holder owns.
   */
  private carriedSymbols(
    input: PlanAdmissionInput,
    withheldFiles: readonly DeferredResource[],
  ): DeferredResource[] {
    const grounding = input.plan.grounding;
    const locate = input.symbolRangesInFile;
    if (grounding === undefined || locate === undefined) {
      return [];
    }
    const withheld = new Set(withheldFiles.map((entry) => entry.resourceId));
    const remaining = input.plan.expectedFiles.filter(
      (file) => !withheld.has(file),
    );
    const ranges = remaining.map((file) => locate(file));
    if (ranges.some((entry) => entry === undefined)) {
      return [];
    }
    const located = new Set(
      ranges
        .flatMap((entry) => entry ?? [])
        .map((range) => range.name.toLowerCase()),
    );
    const contested = this.contested(input, input.plan, {
      resourceType: "symbol",
      evidence: "symbol_overlap",
      declared: input.plan.expectedSymbols,
    });
    return contested.filter((resource) => {
      const referents = grounding.symbolReferents.filter(
        (entry) => entry.declared === resource.resourceId,
      );
      return (
        referents.length > 0 &&
        !located.has(resource.resourceId.toLowerCase()) &&
        referents.every(
          (entry) => !located.has(entry.resolved.toLowerCase()),
        )
      );
    });
  }

  /** Declared files that executing work is holding, with who holds each. */
  private contestedFiles(input: PlanAdmissionInput): DeferredResource[] {
    return this.contested(input, input.plan, {
      resourceType: "file",
      evidence: "file_overlap",
      declared: uniqueRepositoryPaths(input.plan.expectedFiles),
    });
  }

  /**
   * Symbols still held once the contested files are gone, if and only if they
   * can be enforced.
   *
   * Enforcement means being able to answer "did this patch reach into that
   * symbol" for every file being granted, which needs line positions for all
   * of them. One unreadable file among them and the answer is no symbol at
   * all: a withheld symbol the control plane cannot check is an instruction to
   * the agent and nothing more, and this feature does not rest on agents
   * following instructions.
   */
  private contestedSymbols(
    input: PlanAdmissionInput,
    reduced: AgentPlan,
  ): DeferredResource[] {
    const locate = input.symbolRangesInFile;
    if (
      locate === undefined ||
      reduced.expectedFiles.some((file) => locate(file) === undefined)
    ) {
      return [];
    }
    return this.contested(input, reduced, {
      resourceType: "symbol",
      evidence: "symbol_overlap",
      declared: reduced.expectedSymbols,
    });
  }

  /**
   * Resources of one kind that executing work is holding, with who holds each.
   *
   * Both halves of arbitration are asked, because they catch different things:
   * conflict scoring sees two plans naming the same resource, ownership sees a
   * live lease on one. A resource either of them names is contested.
   */
  private contested(
    input: PlanAdmissionInput,
    candidate: AgentPlan,
    kind: {
      resourceType: ResourceType;
      evidence: ConflictEvidence["kind"];
      declared: readonly string[];
    },
  ): DeferredResource[] {
    const taskId = candidate.taskId;
    const others = input.active.filter((entry) => entry.taskId !== taskId);
    const contested = new Map<
      string,
      { heldBy: Set<TaskId>; reasons: Set<string> }
    >();
    const note = (id: string, holder: TaskId, reason: string): void => {
      const entry = contested.get(id) ?? {
        heldBy: new Set<TaskId>(),
        reasons: new Set<string>(),
      };
      entry.heldBy.add(holder);
      entry.reasons.add(reason);
      contested.set(id, entry);
    };

    for (const entry of others) {
      const assessment = this.conflicts.assess(candidate, entry.plan);
      if (assessment === undefined || !structuralConflict(assessment)) {
        continue;
      }
      for (const item of assessment.evidence) {
        if (item.advisory === true || item.kind !== kind.evidence) {
          continue;
        }
        for (const id of item.resources) {
          note(
            id,
            entry.taskId,
            `also declared by executing task ${entry.taskId}`,
          );
        }
      }
    }
    for (const lease of this.seededOwnership(input, others).blockersFor(
      candidate,
    )) {
      if (lease.resourceType !== kind.resourceType) {
        continue;
      }
      note(
        lease.resourceId,
        lease.taskId,
        `owned by ${lease.taskId} in ${lease.mode} mode until ${lease.expiresAt}`,
      );
    }

    // A grounded plan's conflicts surface under the *real* names verification
    // mapped its declarations to, but the only thing withholding can act on
    // is a declaration — that is what reduction removes and enforcement holds
    // the agent to. So a contested referent is charged to the declaration
    // that carries it: withhold `src/checkout.js` because the `total.js` it
    // really names is held by someone else.
    const carriers = new Map<string, string>();
    const grounding = candidate.grounding;
    if (grounding !== undefined) {
      if (kind.resourceType === "file") {
        for (const entry of grounding.fileReferents) {
          carriers.set(entry.resolved.toLowerCase(), entry.declared);
        }
      }
      if (kind.resourceType === "symbol") {
        for (const entry of grounding.symbolReferents) {
          carriers.set(entry.resolved.toLowerCase(), entry.declared);
        }
      }
    }

    const declared = new Set(kind.declared);
    const withholdable = new Map<
      string,
      { heldBy: Set<TaskId>; reasons: Set<string> }
    >();
    for (const [id, entry] of contested) {
      const carrier = declared.has(id)
        ? id
        : carriers.get(id.toLowerCase());
      if (carrier === undefined || !declared.has(carrier)) {
        continue;
      }
      const merged = withholdable.get(carrier) ?? {
        heldBy: new Set<TaskId>(),
        reasons: new Set<string>(),
      };
      for (const holder of entry.heldBy) {
        merged.heldBy.add(holder);
      }
      for (const reason of entry.reasons) {
        merged.reasons.add(
          carrier === id ? reason : `via grounded referent ${id}: ${reason}`,
        );
      }
      withholdable.set(carrier, merged);
    }
    return [...withholdable]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]): DeferredResource => ({
        resourceType: kind.resourceType,
        resourceId: id,
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

    // Verification is a precondition for concurrency with *related* work, not
    // for running. A plan that names nothing real says nothing usable about
    // what it will touch, so conflict scoring against it is theatre: the
    // scores would compare fiction with fact and find no overlap. But an
    // unverifiable plan is not automatically a lying one — a task creating a
    // new module declares only files that do not exist yet, and its write
    // scope is still enforced against exactly those declarations. What
    // separates the two cases is the objective: two tasks talking about the
    // same thing plausibly want the same code however differently they
    // misname it, so those are serialised; work about something else entirely
    // keeps its concurrency. The same rule holds from the other side, against
    // executing plans that could not be verified.
    if (others.length > 0 && planGroundingConfidence(plan) === "ungrounded") {
      const related = others.filter((entry) =>
        relatedObjectives(plan, entry.plan),
      );
      if (related.length > 0) {
        return {
          ...shared,
          status: "sequenced",
          ownershipGrants: [],
          constraints: [
            "Plan again naming files and symbols that exist in the repository, " +
              "or resubmit once the executing tasks integrate",
          ],
          blockedBy: related.map((entry) => entry.taskId).sort(),
          conflicts: [],
          explanation:
            "Plan verification found none of this plan's declared files or " +
            "symbols in the repository, and executing work shares its stated " +
            `objective, so the two cannot be proven disjoint: ${(plan.grounding?.notes ?? []).join("; ")}`,
          retryAfterMs,
        };
      }
    }
    const ungroundedActive = others.filter(
      (entry) =>
        planGroundingConfidence(entry.plan) === "ungrounded" &&
        relatedObjectives(plan, entry.plan),
    );
    if (ungroundedActive.length > 0) {
      return {
        ...shared,
        status: "sequenced",
        ownershipGrants: [],
        constraints: [
          "Start from canonical state after the unverifiable tasks integrate",
        ],
        blockedBy: ungroundedActive.map((entry) => entry.taskId).sort(),
        conflicts: [],
        explanation:
          "Executing work about the same objective could not be verified " +
          "against the repository, so its real footprint is unknown: " +
          ungroundedActive.map((entry) => entry.taskId).join(", "),
        retryAfterMs,
      };
    }

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
