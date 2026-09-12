import type { CoordinationStore } from "@coord/persistence";
import {
  renderRepositoryContext,
  type HandoffEvidence,
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
 * The most of one validation label worth putting in a prompt line.
 *
 * A label is free text on every path that supplies one — the project config
 * file, which lives in the repository being worked on, and the `commands` of
 * a plan an agent wrote. Neither bounds it. Unbounded, one label would push
 * the curated note out of the prompt it is meant to sit under.
 */
const MAX_LABEL_CHARS = 120;

/**
 * The most pitfall lines worth carrying, and the count is stated when it
 * bites: a block that silently dropped lines would be a projection claiming
 * to be the whole of what the record says.
 */
const MAX_PITFALL_LINES = 20;

/**
 * One line of a label, safe to quote.
 *
 * Nothing on the way here rejects a newline or a backtick in a label — the
 * config loader refuses only a NUL, and a plan's commands come from an
 * agent. Both matter in this block more than anywhere else they are
 * rendered, because this block's whole job is to say who wrote it: a label
 * carrying a newline and `## Standing context for this repository` would
 * open, inside the block headed "not written by anyone", a heading claiming
 * a named person stands behind what follows. That is the one confusion the
 * two headings exist to prevent. A backtick closes the code span and hands
 * the rest of the line to the reader as prose, which is the same trick with
 * one fewer character.
 *
 * So whitespace collapses to single spaces, backticks become apostrophes,
 * and the result is bounded — on code points, so a label ending in an emoji
 * or a non-BMP script is not cut into half a character. The label is a
 * reference, not prose; a reader who needs its exact bytes has the handoff
 * that recorded it.
 */
function quotableLabel(value: string): string {
  const flattened = value.replace(/\s+/gu, " ").trim().replace(/`/gu, "'");
  if (flattened.length <= MAX_LABEL_CHARS) {
    return flattened;
  }
  // Trailing high surrogate dropped rather than left orphaned by the cut.
  return `${flattened.slice(0, MAX_LABEL_CHARS).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

/**
 * When a handoff was written, or `undefined` when the record does not say.
 *
 * Never a guess: a `createdAt` that is missing or unparseable makes the date
 * unknown, and the line says so rather than dating the failure from
 * something else it happens to have.
 */
function writtenAt(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The day a failure was recorded, in the words the evidence allows. */
function dayOf(at: number | undefined): string {
  return at === undefined
    ? "date unknown"
    : new Date(at).toISOString().slice(0, 10);
}

/**
 * A validation result recorded on a handoff, or `undefined`.
 *
 * `isTaskHandoff` checks that `completed` is an array and nothing whatever
 * about what is in it, so a row written by an older writer — or one hand
 * edited, or an archived one from a schema since changed — arrives here with
 * anything at all in these fields. Reading one must not throw: the tallies
 * are a nicety, and a planning round that dies on a malformed audit row
 * seeds the task with nothing at all.
 */
function validationEvidence(
  entry: unknown,
): { reference: string; detail: string } | undefined {
  const evidence = entry as Partial<HandoffEvidence> | null | undefined;
  if (
    evidence === null ||
    evidence === undefined ||
    typeof evidence !== "object" ||
    evidence.kind !== "validation" ||
    typeof evidence.reference !== "string" ||
    typeof evidence.detail !== "string"
  ) {
    return undefined;
  }
  return { reference: evidence.reference, detail: evidence.detail };
}

interface PitfallTally {
  ran: Set<string>;
  failed: Set<string>;
  lastFailure: { taskId: string; at: number | undefined } | undefined;
}

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
 *
 * Every line carries the day of the most recent failure, because a pitfall
 * is a claim about what does not work *here, now*: three failures last week
 * is a broken command and three from February is a command somebody fixed.
 * The date comes from the handoff's own `createdAt`, and the failure named
 * is the one with the latest date rather than the first in the array —
 * newest-first is what `findTaskHandoffs` promises, not what this function
 * can check, and "most recently" has to be true whoever calls it.
 *
 * Counts only evidence it can read. A validation entry whose detail is not
 * one of the two `handoff.ts` writes — and a malformed one — is evidence of
 * nothing and leaves both counts alone, so the ratio is over tasks whose
 * result for that label is actually on the record.
 */
export function derivePitfalls(handoffs: readonly TaskHandoff[]): string {
  const tallies = new Map<string, PitfallTally>();
  for (const handoff of handoffs) {
    const record = handoff as Partial<TaskHandoff> | null | undefined;
    if (
      record === null ||
      record === undefined ||
      typeof record.taskId !== "string" ||
      !Array.isArray(record.completed)
    ) {
      continue;
    }
    const taskId = record.taskId;
    const at = writtenAt(record.createdAt);
    for (const candidate of record.completed) {
      const entry = validationEvidence(candidate);
      if (entry === undefined) {
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
        lastFailure: undefined,
      };
      tally.ran.add(taskId);
      if (failed) {
        tally.failed.add(taskId);
        const current = tally.lastFailure;
        // Newest first, as `findTaskHandoffs` returns them, so the first
        // failure seen holds unless a later one is dated after it. An
        // unknown date never displaces a known one: it is not evidence of
        // being more recent.
        if (
          current === undefined ||
          (at !== undefined && current.at !== undefined && at > current.at)
        ) {
          tally.lastFailure = { taskId, at };
        }
      }
      tallies.set(entry.reference, tally);
    }
  }
  // Worst first, then by label, so the lines the cap keeps are the ones
  // worth keeping. Compared by code unit rather than by `localeCompare`,
  // which orders by whatever locale data the host happens to carry — the
  // same evidence has to render the same block everywhere.
  const ranked = [...tallies.entries()]
    .filter(([, tally]) => tally.failed.size >= 2)
    .sort(
      ([leftLabel, left], [rightLabel, right]) =>
        right.failed.size - left.failed.size ||
        (leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0),
    );
  if (ranked.length === 0) {
    return "";
  }
  const lines = ranked
    .slice(0, MAX_PITFALL_LINES)
    .map(
      ([label, tally]) =>
        `- \`${quotableLabel(label)}\` failed in ${tally.failed.size} of the ` +
        `last ${tally.ran.size} tasks that ran it (most recently ` +
        `${quotableLabel(tally.lastFailure?.taskId ?? "unknown")}, ` +
        `${dayOf(tally.lastFailure?.at)})`,
    );
  if (ranked.length > MAX_PITFALL_LINES) {
    lines.push(
      `- …and ${ranked.length - MAX_PITFALL_LINES} further labels failed in ` +
        "two or more tasks, not listed here.",
    );
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
