/**
 * A push nobody here asked permission for.
 *
 * Everything else in this system arrives through a door that arbitrates it.
 * An agent's work is planned, admitted, leased and promoted; a person's
 * browser edit is checked against live holds before the bytes land. A push
 * straight to the origin goes through none of that. Somebody on a laptop
 * renames an exported function on `main`, and this mirror — which every plan
 * is written against — does not know until a sync, a refused push, or a merge
 * that fails for a reason nobody can trace back.
 *
 * That is the last unmodelled door, and it does not close: people are allowed
 * to push to their own repository. What it can do is stop being invisible.
 *
 * **Recorded as a branch, because a branch is what it is.** Upstream `main`
 * with commits canonical does not have is a line of work in contention with
 * every open branch, which is exactly what {@link claimFromChangeSet} already
 * describes and exactly what `branchClaimsAsActivePlans` already arbitrates.
 * Nothing new decides anything here: the claim goes in under a name that says
 * where it came from, and the ladder that has always handled two branches
 * handles this one.
 *
 * **Held only while it is true.** The claim describes the gap between the
 * mirror and its origin. The moment canonical takes those commits the gap is
 * gone, the work is in everybody's base, and a claim still sitting there
 * would sequence plans against changes they already contain — which is worse
 * than never having recorded it, because it looks like it is working.
 */

import type { RecordBranchClaimInput } from "@coord/persistence";
import type { ClaimedShape } from "@coord/persistence";

/**
 * The branch a push to `main` is recorded under.
 *
 * Prefixed rather than recorded as `main` itself for two reasons that both
 * matter. Canonical's own branch is the base every plan is written against,
 * and a claim on it would be read as "the base holds these files" rather than
 * "these files moved somewhere you have not got yet". And a reader seeing
 * `origin/main` in a warning knows immediately that the answer is a sync,
 * which is the one thing this can never tell them by pointing at a task.
 */
export function upstreamBranchName(upstreamBranch: string): string {
  return `origin/${upstreamBranch}`;
}

/** The task id an external push is recorded under, so it is never mistaken. */
export const UPSTREAM_TASK_ID = "external-push";

/**
 * What the origin holds that this mirror does not.
 *
 * Deliberately not a `ChangeSet`: there are no patches, because nothing here
 * replayed anything. The files and the revision are read from the mirror's
 * own view of the remote, and the semantic surface is read from an index at
 * that revision — the same read `holdOnBranch` does for an agent's work, for
 * the same reason. A claim built from a guess is worse than none.
 */
export interface UpstreamGap {
  repositoryId: string;
  upstreamBranch: string;
  /** The remote tip. */
  revision: string;
  /** Canonical's tip, which is what the gap is measured from. */
  mirrorRevision: string;
  files: readonly string[];
  resources?: {
    symbols: readonly string[];
    apis: readonly string[];
    schemas: readonly string[];
    configKeys: readonly string[];
    services: readonly string[];
  };
  contracts?: { shapes: readonly ClaimedShape[] };
}

/**
 * The gap, as a claim the admission ladder already knows how to arbitrate.
 *
 * `ranges` is empty and stays empty. An agent's claim carries the lines it
 * changed because it produced the patches and knows them exactly; a push has
 * patches too, but reading them would mean diffing every file to record an
 * advisory that never refuses anything — expensive, on a timer, for a warning
 * the file list already gives. The enforced half is the semantic surface, and
 * that is read properly or not at all.
 */
export function claimFromUpstreamGap(gap: UpstreamGap): RecordBranchClaimInput {
  return {
    repositoryId: gap.repositoryId,
    branch: upstreamBranchName(gap.upstreamBranch),
    taskId: UPSTREAM_TASK_ID,
    revision: gap.revision,
    symbols: [...(gap.resources?.symbols ?? [])],
    apis: [...(gap.resources?.apis ?? [])],
    schemas: [...(gap.resources?.schemas ?? [])],
    configKeys: [...(gap.resources?.configKeys ?? [])],
    services: [...(gap.resources?.services ?? [])],
    ranges: [],
    shapes: [...(gap.contracts?.shapes ?? [])],
  };
}

/**
 * Whether a gap is worth recording at all.
 *
 * A gap with no files is a mirror that is level or a push of nothing, and a
 * claim with no surface would sit in the list saying "somebody pushed" with
 * no way to act on it. A gap the index could not be read for is recorded
 * anyway — the file list alone still narrows through `interfaceScopeOf`, and
 * a migration or a lockfile in that list is a real warning without a single
 * symbol being resolved.
 */
export function gapIsWorthRecording(gap: UpstreamGap): boolean {
  return gap.files.length > 0 && gap.revision !== gap.mirrorRevision;
}

/**
 * One sentence for a reader, in the place they will meet this.
 *
 * Names the remedy, because the remedy is the whole point and is not
 * guessable from the warning: no plan can be narrowed around this and no
 * agent can wait it out. Somebody has to pull.
 */
export function describeUpstreamGap(gap: UpstreamGap): string {
  const count = gap.files.length;
  const named = gap.files.slice(0, 3).join(", ");
  const rest = count - Math.min(count, 3);
  return (
    `origin/${gap.upstreamBranch} has ${String(count)} file` +
    `${count === 1 ? "" : "s"} this mirror has not got` +
    `${named === "" ? "" : ` — ${named}${rest > 0 ? ` and ${String(rest)} more` : ""}`}` +
    `. Somebody pushed straight to the origin. Plans here are written` +
    ` against ${gap.mirrorRevision.slice(0, 8)} until canonical pulls` +
    ` ${gap.revision.slice(0, 8)}.`
  );
}
