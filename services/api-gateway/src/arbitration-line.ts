/**
 * The one sentence the room is told when arbitration decides an order.
 *
 * Lifted out of the server so it can be read and tested as what it is — a
 * rendering of a decision, with no I/O in it. Every name that reaches here is
 * already resolved for display; the choices left are which of them to say and
 * what to call the thing they are contending over.
 */

/** One resource an admission withheld, as much of it as a sentence needs. */
export interface DeferredRef {
  resourceType: string;
  resourceId: string;
  /** Set when this deferral is a consequence of another, not a loss itself. */
  implied?: boolean;
}

export interface ArbitrationAnnouncement {
  /** Display name of the task whose admission this is. */
  held: string;
  /** Display names from the decision's `blockedBy`, deduped. */
  blockedByNames: readonly string[];
  /**
   * Display names of the tasks holding the withheld resources, deduped.
   *
   * A partial admission sets `blockedBy` to nothing on purpose — its holder is
   * executing, and what is held up is named per resource instead. Reading only
   * `blockedBy` therefore left the sentence with nobody in it, and it said so:
   * "@Rhea and work in flight have conflicting files ... once work in flight
   * is done". These are the names that case needs.
   */
  holderNames: readonly string[];
  /** What each side was asked to do, for the one-agent phrasing. */
  heldWork: string;
  blockerWork: string;
  status: string;
  partial: boolean;
  grantedFiles: readonly string[];
  deferred: readonly DeferredRef[];
}

/** How many names a clause prints before it starts counting instead. */
const NAMED = 4;

function clause(names: readonly string[]): string {
  return (
    names.slice(0, NAMED).join(", ") +
    (names.length > NAMED ? ` and ${String(names.length - NAMED)} more` : "")
  );
}

/**
 * The resources worth naming, out of everything an admission withheld.
 *
 * A withheld file takes every symbol, route and schema inside it along, and
 * each of those is recorded so enforcement can check it. They are the same
 * loss counted again, which is how a plan of five files told its room it had
 * lost 969 things — more things than the repository has files.
 *
 * Filtering by type would have been the easy version and the wrong one: a
 * split can withhold a file *and* a symbol in a different file at the same
 * time, and that symbol is the whole point of splitting. So the decision reads
 * the flag admission sets, which says whether a deferral stands on its own.
 */
export function namedDeferrals(
  deferred: readonly DeferredRef[],
): readonly DeferredRef[] {
  const standalone = deferred.filter((entry) => entry.implied !== true);
  // Everything implied by something absent should not happen; if it does, a
  // list is still better than saying "the rest".
  return standalone.length > 0 ? standalone : deferred;
}

/**
 * What to call the things two tasks are contending over.
 *
 * "Files" was said of everything, so a route came out as a file: the room was
 * told @Rhea had conflicting files and handed `GET /app.js` among them. The
 * type is on every resource; this is only a matter of reading it.
 */
function contendedNoun(named: readonly DeferredRef[]): string {
  return named.every((entry) => entry.resourceType === "file")
    ? "files"
    : "work";
}

export function arbitrationLine(input: ArbitrationAnnouncement): string {
  // `blockedBy` first, because a sequenced decision names its blocker there
  // and that is the task the reader is waiting on. Holders are the partial
  // admission's answer to the same question.
  const blockers =
    input.blockedByNames.length > 0 ? input.blockedByNames : input.holderNames;
  const blocker = blockers.length > 0 ? blockers.join(" and ") : "work in flight";
  // Only a resolved agent name can be shared by two tasks and still mean one
  // agent. The objective fallback is per task, so two of them matching would
  // be two tasks asked for the same thing, which is a different sentence.
  const oneAgent =
    input.held.startsWith("@") &&
    blockers.length === 1 &&
    blockers[0] === input.held;

  if (input.partial) {
    const named = namedDeferrals(input.deferred);
    const deferredNames = named.map((entry) => entry.resourceId);
    const granted =
      input.grantedFiles.length > 0
        ? clause([...input.grantedFiles])
        : "the free part";
    const rest = deferredNames.length > 0 ? clause(deferredNames) : "the rest";
    // Both halves get a verb. Without one the two lists ran together — "starts
    // on styles.css now, screen-chats.js, assets.test.ts and 965 more once
    // work in flight is done" — and there was no way to see where what it got
    // ended and what it is waiting for began.
    return oneAgent
      ? `⚖️ ${input.held} is working on multiple tasks that conflict — it ` +
          `starts on ${granted} now and takes ${rest} once ` +
          `${input.blockerWork} is done.`
      : `⚖️ ${input.held} and ${blocker} have conflicting ` +
          `${contendedNoun(named)} — ${input.held} starts on ${granted} now ` +
          `and takes ${rest} once ${blocker} is done.`;
  }

  if (input.status === "blocked") {
    // Not "so I'm narrowing the plan". What narrows is the *claim* on the
    // repository, never the ask — but a reader watching their own request go
    // by has no way to tell those apart, and took the line as notice that the
    // thing they asked for was being cut down. The decision this announces is
    // an order of work, so that is what it says.
    return oneAgent
      ? `⚖️ ${input.held} is working on multiple tasks that conflict — it ` +
          `will do ${input.blockerWork} first, then ${input.heldWork}.`
      : `⚖️ ${input.held} and ${blocker} have conflicting files — ` +
          `${input.held} will wait for ${blocker} to go first.`;
  }

  return oneAgent
    ? `⚖️ ${input.held} is working on multiple tasks that conflict — ` +
        `${input.heldWork} starts once ${input.blockerWork} is done.`
    : `⚖️ ${input.held} and ${blocker} have conflicting files — ` +
        `${input.held} starts once ${blocker} is done.`;
}
