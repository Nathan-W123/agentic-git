import {
  createId,
  deferredFilePaths,
  planAdmissionPartial,
  uniqueRepositoryPaths,
  type AgentPlan,
  type ChangeSet,
  type DeferredResource,
  type FilePatch,
  type PlanAdmission,
} from "@coord/shared-types";

/**
 * What happens to a changeset produced under a partial admission.
 *
 * The agent was told which files it did not own, and a well-behaved one comes
 * back having left them alone. Nothing here relies on that. The admitted plan
 * is the contract, and this is where the contract is enforced against the
 * bytes rather than against the agent's own account of what it did: every
 * patch is placed in exactly one of three buckets, and only the first is ever
 * applied to canonical.
 */
export interface ChangeSetSplit {
  /** Patches inside the granted scope. The only ones that reach canonical. */
  granted: ChangeSet;
  /** Patches on deferred files. Never applied; the work is requeued instead. */
  deferred: FilePatch[];
  /** Patches on files that were neither granted nor deferred. */
  escaped: string[];
}

/**
 * Splits a changeset along the line the admission drew.
 *
 * `plan` is the admitted plan — already reduced when the admission was
 * partial — so "granted" means exactly what ownership was issued for.
 */
export function splitChangeSet(
  plan: AgentPlan,
  admission: PlanAdmission,
  changeSet: ChangeSet,
): ChangeSetSplit {
  const granted = new Set(uniqueRepositoryPaths(plan.expectedFiles));
  const deferred = new Set(deferredFilePaths(admission));
  const grantedPatches: FilePatch[] = [];
  const deferredPatches: FilePatch[] = [];
  const escaped: string[] = [];

  for (const patch of changeSet.patches) {
    if (granted.has(patch.path)) {
      grantedPatches.push(patch);
    } else if (deferred.has(patch.path)) {
      deferredPatches.push(patch);
    } else {
      escaped.push(patch.path);
    }
  }

  return {
    granted:
      deferredPatches.length === 0
        ? changeSet
        : {
            ...changeSet,
            // A derived artifact gets its own identity: what is recorded and
            // promoted is this subset, not the changeset the agent handed over.
            id: createId("changeset"),
            patches: grantedPatches,
          },
    deferred: deferredPatches,
    escaped: [...new Set(escaped)].sort(),
  };
}

/**
 * Marks a task as the remainder of an earlier partial admission.
 *
 * Follow-ups are admitted all-or-nothing, and this is how that is recognised
 * without a new column on the task record. One split per task is the whole
 * termination argument: without it a task could shed one file per round
 * indefinitely, each round costing a full agent run.
 */
export const DEFERRED_SCOPE_MARKER = "[deferred scope]";

export function isDeferredScopeFollowUp(objective: string): boolean {
  return objective.includes(DEFERRED_SCOPE_MARKER);
}

/**
 * The objective of the follow-up task carrying a partial admission's remainder.
 *
 * It names the deferred resources and nothing else, so the agent that picks it
 * up plans a small task rather than replanning the original one — the granted
 * part is already in canonical by the time this is queued.
 */
export function deferredScopeObjective(
  objective: string,
  deferred: readonly DeferredResource[],
): string {
  const resources = deferred
    .map((resource) => resource.resourceId)
    .sort()
    .join(", ");
  return (
    `${DEFERRED_SCOPE_MARKER} ${objective.trim()} — only the part of this ` +
    `objective that belongs in ${resources}. The rest of the original task ` +
    "is already integrated into canonical; do not redo it."
  );
}

/** Whether an admission left work that a follow-up task has to pick up. */
export function hasDeferredScope(admission: PlanAdmission): boolean {
  return planAdmissionPartial(admission);
}
