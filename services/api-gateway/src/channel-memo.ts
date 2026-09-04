/**
 * What a channel remembers about itself, in a few hundred tokens.
 *
 * Thread context (see `thread-context.ts`) answers "what was said in this
 * thread". This answers the wider question an agent needs before it starts:
 * what has this room already decided, so the same ground is not relitigated
 * in a new thread.
 */

import { collapseWhitespace, textOverlap } from "./text.js";
import { estimateTokens, truncateToTokens } from "./thread-context.js";

/**
 * How much of the rest of the channel a task carries with it.
 *
 * Small on purpose, and an order of magnitude under the thread's own budget
 * (`THREAD_CONTEXT_TOKEN_BUDGET`). A thread is what the work is *about* and
 * is worth paying for in full; the room around it is background, and the
 * failure it exists to fix — a brand-new thread starting from zero after the
 * channel spent ten messages settling something — is fixed by a handful of
 * lines. Anything more would dilute a focused request with the room's other
 * business, which is the cost this layer has to stay under.
 */
export const CHANNEL_MEMO_TOKEN_BUDGET = 320;
/** The most conversations one memo speaks for, whatever the budget allows. */
export const CHANNEL_MEMO_MAX_THREADS = 5;
/**
 * The newest conversations that are carried without having to earn it.
 *
 * What the room settled an hour ago is standing context for whatever is asked
 * next, even when it shares no words with it. Beyond these, an older thread
 * has to look relevant to be worth the room.
 */
export const CHANNEL_MEMO_RECENT_THREADS = 2;
/**
 * How much an older conversation must have in common with the request before
 * its decision is carried.
 *
 * Lower than the thread-level bar: these lines are one sentence each, so they
 * share fewer words with the request than a whole message would, and the
 * budget above already bounds how many can get in.
 */
export const CHANNEL_MEMO_RELEVANCE_MIN = 0.08;
/** How far back down the channel the memo looks for those conversations. */
export const CHANNEL_MEMO_SCAN_LIMIT = 40;
/** Older than this is finished business, not the room's current state. */
export const CHANNEL_MEMO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The most any one conversation's line may take of the budget. */
export const CHANNEL_MEMO_MAX_SUBJECT_TOKENS = 24;
export const CHANNEL_MEMO_MAX_DECISION_TOKENS = 44;

/**
 * The words that mark a message as somebody settling something rather than
 * thinking aloud.
 *
 * A deliberately plain test. Everything an agent posts as an `outcome` is
 * already a conclusion and skips this; this is what lets a conversation that
 * ended in people talking — "we're going with the queue instead" — still
 * leave something behind, without dragging the rest of the chatter with it.
 */
export const CHANNEL_DECISION_RE =
  /\b(decid\w*|agreed|settled on|going with|went with|instead of|rather than|chose|choosing|opted|opting|we will|we'll|won't|will not|not going to|the plan is|conclusion)\b/iu;

/** Kinds that never speak for a conversation in the memo. */
export const CHANNEL_MEMO_SKIP_KINDS = new Set(["progress", "system", "plan"]);

/** One channel conversation, in the little of it a memo reads. */
export interface ChannelMemoThread {
  id: string;
  kind?: string;
  content: string;
  createdAt?: string;
  deletedAt?: string;
  replies?: ReadonlyArray<{ kind?: string; content: string }>;
}

/**
 * One conversation, in the one line the rest of the channel needs from it.
 *
 * The subject is the message that opened it, which is what the conversation
 * was about. The decision is its ending — the agent's `outcome` reply where
 * there is one, otherwise the last thing said in it that reads as somebody
 * settling something. A thread that settled nothing returns `undefined`:
 * carrying its opening line alone would be exactly the undirected chatter
 * this layer must not spend a focused request's context on.
 */
export function summariseChannelThread(
  thread: ChannelMemoThread,
): string | undefined {
  if (thread.deletedAt !== undefined) {
    return undefined;
  }
  if (thread.kind !== undefined && CHANNEL_MEMO_SKIP_KINDS.has(thread.kind)) {
    return undefined;
  }
  const subject = collapseWhitespace(thread.content);
  if (subject.length === 0) {
    return undefined;
  }
  const replies = (thread.replies ?? []).filter(
    (reply) =>
      !CHANNEL_MEMO_SKIP_KINDS.has(reply.kind ?? "") &&
      collapseWhitespace(reply.content).length > 0,
  );
  let decision: string | undefined;
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index];
    if (reply === undefined) {
      continue;
    }
    if (reply.kind === "outcome") {
      decision = collapseWhitespace(reply.content);
      break;
    }
    if (decision === undefined && CHANNEL_DECISION_RE.test(reply.content)) {
      // Kept, but the search carries on: an `outcome` further back is the
      // conversation's actual ending and outranks anything said after it.
      decision = collapseWhitespace(reply.content);
    }
  }
  const head = truncateToTokens(subject, CHANNEL_MEMO_MAX_SUBJECT_TOKENS);
  if (decision === undefined) {
    // Nothing under it, but the opening itself settled something — somebody
    // saying "we're going with the queue" and nobody needing to reply.
    return CHANNEL_DECISION_RE.test(subject) ? head : undefined;
  }
  return `${head} → ${truncateToTokens(
    decision,
    CHANNEL_MEMO_MAX_DECISION_TOKENS,
  )}`;
}

/**
 * What the rest of the channel has settled, for a request that is about to be
 * dispatched somewhere else in it.
 *
 * Recency first, then relevance — the same order `selectThreadContext` reads
 * a thread in, for the same reason. The newest conversations are the room's
 * current state and are carried outright; older ones have to look like they
 * bear on the request. Everything is one summarised line, never a raw
 * message, so a long argument two threads over costs this request a sentence.
 *
 * Returned oldest first, so the memo reads in the order the room happened.
 */
export function selectChannelMemo(input: {
  /** Channel roots, oldest first, as the store lists them. */
  threads: readonly ChannelMemoThread[];
  /** The request this memo is being assembled for. */
  focus?: string;
  budgetTokens?: number;
  maxThreads?: number;
}): string[] {
  const budget = input.budgetTokens ?? CHANNEL_MEMO_TOKEN_BUDGET;
  const maxThreads = input.maxThreads ?? CHANNEL_MEMO_MAX_THREADS;
  if (budget <= 0 || maxThreads <= 0) {
    return [];
  }
  const summarised = input.threads
    .map((thread, index) => ({ index, line: summariseChannelThread(thread) }))
    .filter(
      (entry): entry is { index: number; line: string } =>
        entry.line !== undefined,
    );
  const focus =
    input.focus === undefined ? "" : collapseWhitespace(input.focus);
  const newest = [...summarised].reverse();
  const kept = new Map<number, string>();
  let spent = 0;
  const take = (entry: { index: number; line: string }): void => {
    const cost = estimateTokens(entry.line);
    if (kept.size >= maxThreads || spent + cost > budget) {
      return;
    }
    kept.set(entry.index, entry.line);
    spent += cost;
  };
  for (const entry of newest.slice(0, CHANNEL_MEMO_RECENT_THREADS)) {
    take(entry);
  }
  if (focus.length > 0) {
    const relevant = newest
      .slice(CHANNEL_MEMO_RECENT_THREADS)
      .map((entry) => ({ ...entry, score: textOverlap(focus, entry.line) }))
      .filter((entry) => entry.score >= CHANNEL_MEMO_RELEVANCE_MIN)
      .sort((left, right) => right.score - left.score);
    for (const entry of relevant) {
      take(entry);
    }
  }
  return [...kept.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, line]) => line);
}
