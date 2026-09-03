/**
 * Scoring which agent should pick up an unaddressed piece of work.
 *
 * Scoring is separate from deciding: this says how well each candidate fits,
 * and the caller applies the margin rules that decide whether the best fit is
 * good enough to act on without asking. A score alone is never a claim.
 */

import type { SubmittedTask } from "@coord/persistence";

import { relevanceTokens } from "./text.js";

/** How many of an agent's most recent submitted tasks feed the activity signal. */
export const RECENT_ACTIVITY_LOOKBACK = 25;

/**
 * Submitted tasks newest first.
 *
 * The store returns them oldest first, and the scorer takes the first
 * {@link RECENT_ACTIVITY_LOOKBACK} it sees per key — so "recent activity"
 * was in fact the *earliest* work. Under twenty-five tasks nothing
 * looked wrong; past that the signal froze on whatever somebody did first in
 * a repository and never moved again, which is the opposite of what it is
 * for.
 *
 * Sorted here rather than in the query because the store's own order is
 * meaningful to everything else that reads it.
 */
export function recentFirst(tasks: readonly SubmittedTask[]): SubmittedTask[] {
  return [...tasks].sort((left, right) =>
    right.submittedAt.localeCompare(left.submittedAt),
  );
}
/** Caps the recent-activity contribution so the declared role/name always leads it. */
export const MAX_ACTIVITY_SCORE = 2;
/** Weight of one overlapping role/name token — see the constants below for how this is used. */
export const ROLE_TOKEN_WEIGHT = 2;
/**
 * Retained for the score's own arithmetic, no longer a gate on dispatching.
 *
 * It used to be the bar a candidate had to clear before anyone would take an
 * unaddressed request, which meant a task sharing no vocabulary with any
 * agent's role went unanswered. Set
 * equal to one overlapping role/name token: recent activity alone (see
 * {@link scoreCandidate}) can never reach this on its own, because it is
 * gated on a role/name match existing in the first place.
 */
export const MIN_CLAIM_SCORE = ROLE_TOKEN_WEIGHT;
/**
 * The winner must beat the runner-up by both a flat margin and a relative
 * one, together. A flat `+2` alone would still let a runner-up of 8 vs a
 * winner of 10 through (clearly too close relatively); a `1.5x` ratio alone
 * would let a winner of 1 vs a runner-up of 0 through on a single
 * coincidental token. Requiring both is what makes "two similarly relevant
 * agents" — the ambiguous case the brief calls out — fail closed instead of
 * picking a coin flip.
 */
export const MIN_MARGIN_ABSOLUTE = ROLE_TOKEN_WEIGHT;
export const MIN_MARGIN_RATIO = 1.5;

/**
 * Scores one candidate's fit for a message.
 *
 * The primary signal is overlap between the message's words and the
 * candidate's declared role plus its display name — genuine free text a
 * channel lets someone set per agent (`setChannelAgentOverride`). An agent
 * nobody has labeled contributes no role tokens at all (role is "" until
 * set — there is no vendor-guessed default), so it competes on name overlap
 * alone, same as any other candidate whose role happens not to match. The
 * secondary signal is
 * a small, capped bonus for recent task activity this candidate's *owner*
 * has actually had in this repository.
 *
 * That activity signal is deliberately coarse, and deliberately reuses data
 * that already exists rather than adding a new tracking system: there is no
 * per-agent recent-files or recent-activity index anywhere in this codebase
 * today (the Changes drawer / `state.changeSet` in `data.js` holds one
 * changeset for whichever session Code currently has open, not a
 * roster-wide per-agent history). What already exists and is cheap to read
 * is `store.listSubmittedTasks({ repositoryId })`, whose records carry
 * `submittedBy`, `agentId` and `objective` for free — no new plumbing. Those
 * two identifiers together are what makes it per *agent*: `submittedBy` is
 * always the owner, so on its own it merged every agent one person owns into
 * a single history, and `agentId` is the deployment's configured agent, which
 * a vendor joins to (see `recentObjectivesFor`). That is still an
 * approximation of "this agent has been active here," not a literal "these
 * are the files it touched," which is why it is weighted low, capped, and —
 * see the `roleOverlap === 0` check below — never enough on its own to make a
 * candidate eligible.
 */
export function scoreCandidate(
  messageTokens: ReadonlySet<string>,
  candidate: { role: string; name: string },
  recentObjectives: readonly string[],
): { score: number; roleOverlap: number } {
  const roleTokens = relevanceTokens(`${candidate.role} ${candidate.name}`);
  let roleOverlap = 0;
  for (const token of roleTokens) {
    if (messageTokens.has(token)) {
      roleOverlap += 1;
    }
  }
  if (roleOverlap === 0) {
    return { score: 0, roleOverlap: 0 };
  }
  let activityOverlap = 0;
  for (const objective of recentObjectives) {
    for (const token of relevanceTokens(objective)) {
      if (messageTokens.has(token)) {
        activityOverlap += 1;
      }
    }
  }
  const score =
    roleOverlap * ROLE_TOKEN_WEIGHT + Math.min(activityOverlap, MAX_ACTIVITY_SCORE);
  return { score, roleOverlap };
}
