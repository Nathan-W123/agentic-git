/**
 * The one sentence said when arbitration decides an order.
 *
 * Lifted out of the server so it can be read and tested as what it is — a
 * rendering of a decision, with no I/O in it. Agent and task names that reach
 * here are already resolved for display; resource ids stay repo-relative so
 * this renderer can compact every name in the sentence together.
 *
 * Two voices, because the line has two places to stand. The held task's own
 * agent says it in its thread, in the first person, to the person who asked
 * for the work — that is the ordinary case and the one people read. The
 * room's third-person version is what is left when no agent account resolves
 * for the held task, and the coordinator speaks it because nobody else can.
 */

import { shortenResourceNamesForMessage } from "./resource-display-name.js";

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
  /**
   * Whether the held task's own agent is saying this, rather than the room.
   *
   * The whole sentence turns on it, so the two are written out rather than
   * conjugated from one shape. In an agent's own thread "@Rhea starts once
   * @Hades is done" is an agent talking about itself in the third person,
   * which reads as a report about somebody else; in the room "I'll start once
   * they're done" names nobody at all.
   */
  firstPerson?: boolean;
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
export function contendedNoun(named: readonly DeferredRef[]): string {
  return named.every((entry) => entry.resourceType === "file")
    ? "files"
    : "work";
}

/**
 * Who the held agent is waiting on, in the words its own sentence needs.
 *
 * Both voices ask the same three questions of the blockers — how to name
 * them, whether they take a plural verb, and what to call them the second
 * time — so the answers are worked out once. Nobody named at all is still
 * somebody to wait for: unattributed work in flight, which is singular and
 * has no pronoun of its own.
 */
function blockerVoice(names: readonly string[]): {
  named: string;
  verb: (singular: string, plural: string) => string;
  /** "once they're done" / "once it's done". */
  done: string;
  /** "let them go first" / "let it go first". */
  them: string;
} {
  return {
    named: names.length > 0 ? names.join(" and ") : "other work in flight",
    verb: (singular, plural) => (names.length > 1 ? plural : singular),
    done: names.length > 0 ? "once they're done" : "once it's done",
    them: names.length > 0 ? "them" : "it",
  };
}

/**
 * The two lists a partial admission splits its work into, already compacted.
 *
 * Granted and deferred names are shortened together rather than separately,
 * because the reader is being asked to tell them apart: two `index.ts` from
 * different packages have to keep enough path between them to be two files.
 */
function splitLists(input: ArbitrationAnnouncement): {
  granted: string;
  rest: string;
  named: readonly DeferredRef[];
} {
  const named = namedDeferrals(input.deferred);
  const displayNames = shortenResourceNamesForMessage([
    ...input.grantedFiles.map((resourceId) => ({
      resourceType: "file",
      resourceId,
    })),
    ...named,
  ]);
  const grantedNames = displayNames.slice(0, input.grantedFiles.length);
  const deferredNames = displayNames.slice(input.grantedFiles.length);
  return {
    granted: grantedNames.length > 0 ? clause(grantedNames) : "the free part",
    rest: deferredNames.length > 0 ? clause(deferredNames) : "the rest",
    named,
  };
}

/**
 * The decision as the held agent's own reply in its own thread.
 *
 * Written the way one worker tells the room what it found: "looks like
 * somebody else is in there, so I'll take my half now and the rest after
 * them". The agent never names itself — it is the one speaking, and its name
 * is already on the bubble.
 */
function firstPersonLine(input: ArbitrationAnnouncement): string {
  const blockers =
    input.blockedByNames.length > 0 ? input.blockedByNames : input.holderNames;
  const blocker = blockerVoice(blockers);
  // Two of this agent's own tasks. There is no other agent to look at, so the
  // sentence is about the order it will take its own work in, and the two
  // tasks are told apart by what each was asked to do.
  const oneAgent =
    input.held.startsWith("@") &&
    blockers.length === 1 &&
    blockers[0] === input.held;

  if (input.partial) {
    const split = splitLists(input);
    return oneAgent
      ? `⚖️ I'm on two tasks that conflict — I'll start on ${split.granted} ` +
          `now and take ${split.rest} once ${input.blockerWork} is done.`
      : `⚖️ Looks like ${blocker.named} ${
          contendedNoun(split.named) === "files"
            ? `${blocker.verb("has", "have")} the same files open`
            : `${blocker.verb("is", "are")} on the same work`
        } — I'll start on ${split.granted} now and take ${split.rest} ` +
          `${blocker.done}.`;
  }

  const opening = `Looks like ${blocker.named} ${blocker.verb(
    "has",
    "have",
  )} the same files open`;

  if (input.status === "blocked") {
    return oneAgent
      ? `⚖️ I'm on two tasks that conflict — I'll do ${input.blockerWork} ` +
          `first, then ${input.heldWork}.`
      : `⚖️ ${opening} — I'll let ${blocker.them} go first.`;
  }

  return oneAgent
    ? `⚖️ I'm on two tasks that conflict — I'll start ${input.heldWork} once ` +
        `${input.blockerWork} is done.`
    : `⚖️ ${opening} — I'll start ${blocker.done}.`;
}

/**
 * What the agent says when the work it was waiting on is out of the way.
 *
 * Replaces the hold rather than standing beside it: the hold described a
 * condition that has stopped being true, and leaving it there next to a
 * second line about starting is how a thread ends up contradicting itself.
 *
 * Deliberately unmarked. The arbitration marker is the handle a later process
 * uses to find a line it has to take back, and this one is a fact about
 * something that happened — it stays in the thread as the account of why this
 * agent was idle for twenty minutes.
 */
export function arbitrationReleaseLine(
  input: ArbitrationAnnouncement,
): string {
  const blockers =
    input.blockedByNames.length > 0 ? input.blockedByNames : input.holderNames;
  const oneAgent =
    input.held.startsWith("@") &&
    blockers.length === 1 &&
    blockers[0] === input.held;
  if (oneAgent) {
    return `Done with ${input.blockerWork} — picking this one up now.`;
  }
  if (blockers.length === 0) {
    // The restart case: this process found a hold it has no memory of posting,
    // so it knows the collision is over and not who it was with.
    return "That's clear now — picking this up.";
  }
  const blocker = blockerVoice(blockers);
  return `${blocker.named} ${blocker.verb(
    "is",
    "are",
  )} done — picking this up now.`;
}

export function arbitrationLine(input: ArbitrationAnnouncement): string {
  if (input.firstPerson === true) {
    return firstPersonLine(input);
  }
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
    const { granted, rest, named } = splitLists(input);
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
