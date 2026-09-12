import type { CoordinationStore } from "@coord/persistence";
import {
  renderRepositoryContext,
  type TaskHandoff,
} from "@coord/shared-types";

/**
 * The one block of prior context a person wrote.
 *
 * Everything else a task is seeded with is projected from evidence the
 * control plane holds — see `handoff.ts`, which says why: a summary written
 * from memory launders guesses into fact. The standing context is different
 * in kind, not a loophole in that rule. A named person stands behind it, it
 * carries a version, and every change is an audit event with an actor, so a
 * wrong note is attributable and correctable in a way a summary is not. It
 * is the place for what no run record can project: which validation command
 * is the one that actually works here, what the directory layout means, the
 * trap everybody falls into once.
 *
 * Rendering lives in `@coord/shared-types` so the gateway, which cannot
 * depend on this package, briefs an editor with exactly the block a planning
 * prompt sees. What is here is the part that needs the store or the handoffs.
 */

/** The evidence prefixes `handoff.ts` writes for a validation command. */
const PASSED_PREFIX = "passed (";
const FAILED_PREFIX = "FAILED with exit";

/** Where the derived block begins, so a reader can tell it from the note. */
export const DERIVED_PITFALLS_HEADING = "## Derived from the coordination record";

/**
 * Where the "we could not read the note" block begins.
 *
 * A third heading rather than a note that reads oddly, for the same reason
 * the derived block has its own: the three have different provenances — a
 * person, the record, and nothing at all — and a reader must be able to tell
 * which one is speaking.
 */
export const UNREADABLE_CONTEXT_HEADING =
  "## Standing context for this repository: could not be read";

/**
 * What a task is told when the note could not be read.
 *
 * Not `""`. `""` is what a repository with no note renders, and a consumer
 * that cannot tell the two apart reads a failed read as "nobody has written
 * anything here, so there is nothing to obey" — which is the one wrong
 * answer this block can produce, and worse than no block at all. So the
 * failure is stated, in the prompt, in the slot the note would have taken.
 */
export const UNREADABLE_STANDING_CONTEXT = [
  UNREADABLE_CONTEXT_HEADING,
  "",
  "The standing context for this repository could not be read from the " +
    "coordination record. Whether the people who work here have written one, " +
    "and what it says, is unknown — which is not the same as there being " +
    "none, and must not be read as this repository having no conventions.",
  "",
  "Check the workspace itself before assuming one, and say in the plan that " +
    "the standing context was unavailable.",
].join("\n");

/**
 * Validation commands that keep failing across tasks, as a block of their own.
 *
 * Computed at read time from handoffs the coordinator already fetched and
 * never persisted: a person promotes a line here into the standing context by
 * writing it there, which is the only way it becomes something somebody
 * stands behind. Its own top-level heading rather than a sub-heading of the
 * curated block, because the two have opposite provenances — one written by
 * a person, one written by nobody — and a reader must not be able to mistake
 * one for the other.
 *
 * A label that failed once is noise: every task fails something at some
 * point. Two or more tasks is the bar, and the counts are given so the
 * reader can weigh it — three of the last twelve is an environment problem,
 * three of three is a command that does not work here at all.
 *
 * Tallied per task, not per handoff. A task that is retried keeps its id and
 * records a handoff per attempt, so counting handoffs would report one
 * task's two attempts as "2 of the last 2 tasks" — the line would then claim
 * more evidence than exists, which is the one thing a projection under a
 * "not written by anyone" heading must never do.
 */
export function derivePitfalls(handoffs: readonly TaskHandoff[]): string {
  const tallies = new Map<
    string,
    { ran: Set<string>; failed: Set<string>; lastFailedTask: string | undefined }
  >();
  // Newest first, as `findTaskHandoffs` returns them, so the first failure
  // seen for a label is the most recent one.
  for (const handoff of handoffs) {
    for (const entry of handoff.completed) {
      if (entry.kind !== "validation") {
        continue;
      }
      const passed = entry.detail.startsWith(PASSED_PREFIX);
      const failed = entry.detail.startsWith(FAILED_PREFIX);
      if (!passed && !failed) {
        continue;
      }
      const tally = tallies.get(entry.reference) ?? {
        ran: new Set<string>(),
        failed: new Set<string>(),
        lastFailedTask: undefined,
      };
      tally.ran.add(handoff.taskId);
      if (failed) {
        tally.failed.add(handoff.taskId);
        tally.lastFailedTask ??= handoff.taskId;
      }
      tallies.set(entry.reference, tally);
    }
  }
  const lines = [...tallies.entries()]
    .filter(([, tally]) => tally.failed.size >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([label, tally]) =>
        `- \`${label}\` failed in ${tally.failed.size} of the last ` +
        `${tally.ran.size} tasks that ran it ` +
        `(most recently ${tally.lastFailedTask ?? "unknown"})`,
    );
  if (lines.length === 0) {
    return "";
  }
  return [
    DERIVED_PITFALLS_HEADING,
    "",
    "Projected from validation results in recorded handoffs, not written by " +
      "anyone; a label that keeps failing is usually an environment or setup " +
      "pitfall worth stating in the standing context above.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * The curated block for one repository, `""`, or a notice that it is unknown.
 *
 * Never throws: seeding is an advantage, and a task that cannot read the note
 * should still do the work. That is the rule the coordinator already applies
 * to its handoff read, but it applies it at the call site with
 * `.catch(() => [])`, because `findTaskHandoffs` — and `seedContextForTask`
 * over it — do throw. The guard is inside this one instead: it has a single
 * caller and no second meaning to preserve for anybody else.
 *
 * What the guard must not do is answer `""`. `""` is a repository with no
 * note, a claim about the record; a store that would not answer is a claim
 * about nothing, and the consumer of both is a prompt that reads the absence
 * of a note as the absence of anything to obey. So the two are different
 * strings, and the failure says what it is. The whole read is guarded, not
 * just the promise: a store implementation that throws before it returns one
 * escapes a `.catch`, and a row that renders badly — a `content` that came
 * back as something other than text — is a read that did not succeed either.
 */
export async function standingContextForTask(
  store: CoordinationStore,
  query: { repositoryId: string },
): Promise<string> {
  try {
    return renderRepositoryContext(
      await store.getRepositoryContext(query.repositoryId),
    );
  } catch {
    return UNREADABLE_STANDING_CONTEXT;
  }
}
