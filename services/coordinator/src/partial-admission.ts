import {
  dividePatchByRanges,
  namesTouchedByPatch,
  type LineRange,
  type NamedRange,
} from "./hunks.js";
import {
  claimCoversPath,
  createId,
  deferredFilePaths,
  planAdmissionPartial,
  uniqueRepositoryPaths,
  type AgentPlan,
  type ChangeSet,
  type DeferredResource,
  type FilePatch,
  type FilePatchStatus,
  type PlanAdmission,
} from "@coord/shared-types";

/**
 * What happens to a changeset produced under a partial admission.
 *
 * The agent was told which files it did not own, and a well-behaved one comes
 * back having left them alone. Nothing here relies on that. The admitted plan
 * is the contract, and this is where the contract is enforced against the
 * bytes rather than against the agent's own account of what it did: every
 * patch is sorted into granted, deferred, or escaped, and only the granted
 * ones are ever applied to canonical.
 *
 * A patch is not always indivisible. Where the admission withheld a symbol
 * inside a file it granted, one file's patch can end up in *both* the granted
 * and deferred sets — split at the hunk, so the edits that stayed clear of the
 * withheld lines land while only the trespassing hunks wait.
 */
export interface ChangeSetSplit {
  /** Patches inside the granted scope. The only ones that reach canonical. */
  granted: ChangeSet;
  /**
   * Patches held back. Never applied; the work is requeued instead. A divided
   * file appears here carrying only the hunks that were withheld.
   */
  deferred: FilePatch[];
  /** Patches on files that were neither granted nor deferred. */
  escaped: string[];
  /**
   * Withheld symbols a patch reached into, by the file that reached. Empty
   * unless the admission withheld something finer than a file.
   */
  withheldSymbols: Record<string, string[]>;
  /**
   * Files whose patch was divided instead of lost whole: the hunks clear of
   * every withheld symbol were promoted and only the trespassing ones held
   * back. Empty when no patch needed dividing or none could be divided.
   */
  divided: DividedPatch[];
}

/** One file's patch, split at the hunks that reached a withheld symbol. */
export interface DividedPatch {
  path: string;
  grantedHunks: number;
  deferredHunks: number;
  /** The withheld symbols the deferred hunks reached into. */
  symbols: string[];
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
  /**
   * Where each symbol lives in one file at the base revision, or `undefined`
   * when that file cannot be parsed. Only consulted when the admission
   * withheld a symbol — and when it did and this cannot answer, the patch is
   * held back rather than promoted on the assumption that it was fine.
   */
  symbolRangesInFile?: (file: string) => readonly NamedRange[] | undefined,
): ChangeSetSplit {
  const granted = new Set(uniqueRepositoryPaths(plan.expectedFiles));
  const deferred = new Set(deferredFilePaths(admission));
  const withheldNames = (admission.deferredResources ?? [])
    .filter((resource) => resource.resourceType === "symbol")
    .map((resource) => resource.resourceId);
  const withheldSet = new Set(withheldNames);
  const grantedPatches: FilePatch[] = [];
  const deferredPatches: FilePatch[] = [];
  const escaped: string[] = [];
  const withheldSymbols: Record<string, string[]> = {};
  const divided: DividedPatch[] = [];

  /**
   * Where the withheld symbols sit in one file.
   *
   * The admission's own answer first, and the index only as the fallback.
   * Arbitration already worked out which lines it was withholding and wrote
   * them onto each resource, and that answer is strictly better than one
   * re-derived here: it can name a span the index cannot. A holder that is
   * going to *add* a function has no range in the index to point at, but
   * arbitration knows the places that function could land — the gaps between
   * declarations, the preamble, the tail — and withholds those. Looking the
   * name up in the index would find nothing and promote the lot.
   */
  const locatedRanges = new Map<string, NamedRange[]>();
  for (const resource of admission.deferredResources ?? []) {
    if (resource.resourceType !== "symbol") {
      continue;
    }
    for (const location of resource.locations ?? []) {
      const existing = locatedRanges.get(location.file) ?? [];
      existing.push({
        name: resource.resourceId,
        startLine: location.startLine,
        endLine: location.endLine,
      });
      locatedRanges.set(location.file, existing);
    }
  }
  const withheldNamedRanges = (
    file: string,
  ): readonly NamedRange[] | undefined =>
    locatedRanges.get(file) ?? symbolRangesInFile?.(file);
  const withheldRangesIn = (file: string): LineRange[] =>
    (withheldNamedRanges(file) ?? []).filter((range) =>
      withheldSet.has(range.name),
    );

  for (const patch of changeSet.patches) {
    if (deferred.has(patch.path)) {
      deferredPatches.push(patch);
      continue;
    }
    // A coordinator-issued claim approves paths no declaration names — a
    // blanket claim approves the repository, a frozen one the directories its
    // holder was already working in — and both were decided against every
    // other holder before they were issued. `assertChangeSetWithinPlan` has
    // always read them that way; this did not, so a claimed task's own writes
    // were bucketed as escapes and its result refused.
    //
    // It went unnoticed while claims were granted only in-process, where the
    // result never reaches this split. The moment a remote worker could hold
    // one, every claimed task failed at integration for writing the files it
    // had been given.
    if (!granted.has(patch.path) && !claimCoversPath(plan, patch.path)) {
      escaped.push(patch.path);
      continue;
    }
    // The file was granted, but a symbol inside it may not have been.
    const reached =
      withheldNames.length === 0
        ? []
        : namesTouchedByPatch(
            patch.patch,
            withheldNamedRanges(patch.path),
            withheldNames,
          );
    if (reached.length > 0) {
      withheldSymbols[patch.path] = reached;
      // One trespassing hunk used to cost the file. It no longer has to: the
      // hunks that stay clear of the withheld lines are a patch in their own
      // right against the same base revision, so they can be promoted while
      // only the trespassing hunks are held back. The division is refused
      // outright for anything the parser does not fully recognise, and for an
      // added or deleted file, where "part of the change" is not a thing that
      // exists — in those cases the whole file is held back as before.
      const division =
        patch.status === "modified"
          ? dividePatchByRanges(patch.patch, withheldRangesIn(patch.path))
          : undefined;
      if (division?.granted !== undefined && division.deferred !== undefined) {
        grantedPatches.push({ ...patch, patch: division.granted });
        deferredPatches.push({ ...patch, patch: division.deferred });
        divided.push({
          path: patch.path,
          grantedHunks: division.grantedHunks,
          deferredHunks: division.deferredHunks,
          symbols: reached,
        });
        continue;
      }
      deferredPatches.push(patch);
      continue;
    }
    grantedPatches.push(patch);
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
    withheldSymbols,
    divided,
  };
}

/**
 * How much withheld patch text is kept. Enough for a handful of real files,
 * bounded so one runaway changeset cannot bloat a hash-chained audit log.
 */
export const WITHHELD_PATCH_BUDGET_BYTES = 64 * 1024;

export interface WithheldPatch {
  path: string;
  status: FilePatchStatus;
  /** Empty when the budget was spent before this patch was reached. */
  patch: string;
  omitted?: boolean;
}

export interface WithheldPatchRecord {
  patches: WithheldPatch[];
  /** At least one patch could not be kept in full. */
  truncated: boolean;
  bytes: number;
}

/**
 * The work a partial admission held back, kept rather than discarded.
 *
 * It is deliberately not replayed later: it was written against a file another
 * task is in the middle of rewriting, so applying it to whatever that file
 * becomes would be publishing a change nobody re-read. What it is good for is
 * telling the agent that picks up the follow-up what was already worked out,
 * so the second attempt is not a cold start.
 *
 * Patches are kept whole or not at all. Half a diff reads like a diff and
 * applies like nothing, which is a worse thing to hand to an agent than an
 * honest note saying it was dropped.
 */
export function withheldPatchRecord(
  patches: readonly FilePatch[],
  budgetBytes = WITHHELD_PATCH_BUDGET_BYTES,
): WithheldPatchRecord {
  const kept: WithheldPatch[] = [];
  let bytes = 0;
  let truncated = false;
  for (const patch of patches) {
    const size = Buffer.byteLength(patch.patch, "utf8");
    if (bytes + size > budgetBytes) {
      truncated = true;
      kept.push({ path: patch.path, status: patch.status, patch: "", omitted: true });
      continue;
    }
    bytes += size;
    kept.push({ path: patch.path, status: patch.status, patch: patch.patch });
  }
  return { patches: kept, truncated, bytes };
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
  /**
   * Files whose patches were held back even though the file itself was
   * granted, because they reached into a withheld symbol. Their other edits
   * went with them, so the follow-up has to cover them too or that work is
   * simply lost.
   */
  alsoDropped: readonly string[] = [],
): string {
  const resources = [
    ...new Set([
      ...deferred.map((resource) =>
        resource.resourceType === "file"
          ? resource.resourceId
          : `${resource.resourceType} ${resource.resourceId}`,
      ),
      ...alsoDropped,
    ]),
  ]
    .sort()
    .join(", ");
  return (
    `${DEFERRED_SCOPE_MARKER} ${objective.trim()} — only the part of this ` +
    `objective that belongs in ${resources}. The rest of the original task ` +
    "is already integrated into canonical; do not redo it."
  );
}
