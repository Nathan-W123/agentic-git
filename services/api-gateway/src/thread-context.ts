/**
 * Choosing which of a thread's lines to carry into a model call.
 *
 * A thread outlives any budget that could hold all of it, so this decides
 * what survives: recent lines always, older lines by relevance, and an
 * explicit notice when something was dropped. The notice matters - a model
 * handed a silently truncated thread answers confidently about a
 * conversation it cannot see.
 */

import { collapseWhitespace, textOverlap } from "./text.js";

/**
 * How much of a thread goes to the model when answering a follow-up.
 *
 * The narration can run to dozens of steps on a long task; the last stretch is
 * what a question like "what did you get done?" is actually about, and sending
 * all of it would spend the reader's usage on the middle of a log nobody asked
 * about.
 *
 * Counted in tokens rather than in entries, because entries are not what
 * costs anything: a line cap sends far more than it meant to when the thread
 * is made of pasted logs, and throws away room it was protecting when the
 * thread is made of one-liners.
 */
export const THREAD_CONTEXT_TOKEN_BUDGET = 1_600;

/**
 * The most any one entry may take of that budget.
 *
 * A single pasted log can be longer than the whole conversation around it.
 * Cutting it short keeps it in the context — a shortened message still says
 * what it was about — rather than letting it push everything else out.
 */
export const THREAD_CONTEXT_MAX_ENTRY_TOKENS = 400;

/**
 * How much an older entry must have in common with the request before it is
 * carried on the budget recency left over.
 *
 * Pure recency silently forgets the decision made thirty messages back that
 * the current question is entirely about. Deliberately low: this never
 * displaces a recent entry, it only spends what would otherwise go unused.
 */
export const THREAD_CONTEXT_RELEVANCE_MIN = 0.12;

/**
 * Roughly what a piece of text costs a model, in tokens.
 *
 * Four characters to the token, the usual English approximation. A real
 * tokeniser would mean carrying one per provider to sharpen a budget that
 * only ever has to be about right.
 */
export function estimateTokens(value: string): number {
  const text = value.trim();
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * `value` shortened to fit `maxTokens`, cut at a word boundary.
 *
 * Ends on a whole word and says it was cut, so a model reads a message that
 * stops rather than one that appears to trail off mid-thought — which it
 * would otherwise be free to complete for itself.
 */
export function truncateToTokens(value: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateTokens(value) <= maxTokens) {
    return value;
  }
  // Two characters back for the ellipsis the cut adds.
  const limit = Math.max(1, maxTokens * 4 - 2);
  const clipped = value.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only honour the word boundary when it is near the end; a single
  // enormous word would otherwise cut the entry down to nothing.
  const kept = (
    lastSpace > limit / 2 ? clipped.slice(0, lastSpace) : clipped
  ).trimEnd();
  return `${kept} …`;
}

/**
 * The line that stands in for thread history the budget could not carry.
 *
 * Present so the gap is visible: a model that can see history was dropped
 * says so when it does not know, instead of answering confidently from the
 * half of the conversation it happens to hold.
 */
export function elidedHistoryNotice(count: number): string {
  return (
    `(${String(count)} earlier message${count === 1 ? "" : "s"} from this ` +
    "thread omitted here to stay within context)"
  );
}

/**
 * The part of a thread that is worth sending to a model, under a token budget.
 *
 * Three things decide it, in order. The opening message always stays — it is
 * what the thread is *about*, and a window that drops it leaves the model
 * reading replies to a question it cannot see. Then the newest entries, which
 * is what a follow-up is usually asking after. Then, on whatever budget is
 * left, older entries that have something in common with the request, so a
 * decision taken early in a long thread is not lost purely for being old.
 *
 * Returns how many entries were left out rather than dropping them silently,
 * so the caller can say so in the prompt.
 */
export function selectThreadContext(input: {
  lines: readonly string[];
  /** The request or question this context is being assembled for. */
  focus?: string;
  budgetTokens?: number;
}): { lines: string[]; elided: number } {
  const budget = input.budgetTokens ?? THREAD_CONTEXT_TOKEN_BUDGET;
  const entries = input.lines
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0)
    .map((line) => truncateToTokens(line, THREAD_CONTEXT_MAX_ENTRY_TOKENS));
  if (entries.length === 0 || budget <= 0) {
    return { lines: [], elided: entries.length };
  }
  const costs = entries.map((line) => estimateTokens(line));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= budget) {
    return { lines: entries, elided: 0 };
  }
  // A root longer than the whole budget is cut to it rather than dropped.
  if ((costs[0] ?? 0) > budget) {
    entries[0] = truncateToTokens(entries[0] ?? "", budget);
    costs[0] = estimateTokens(entries[0] ?? "");
  }
  const kept = new Set<number>([0]);
  let spent = costs[0] ?? 0;
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const cost = costs[index] ?? 0;
    // The recent stretch is kept contiguous — a conversation with holes
    // punched in it wherever a long message sat reads as a different
    // conversation. What falls the far side of this cut can still come back
    // below, on relevance.
    if (spent + cost > budget) {
      break;
    }
    kept.add(index);
    spent += cost;
  }
  const focus =
    input.focus === undefined ? "" : collapseWhitespace(input.focus);
  if (focus.length > 0 && spent < budget) {
    const relevant = entries
      .map((line, index) => ({ index, line }))
      .filter((entry) => !kept.has(entry.index))
      .map((entry) => ({ ...entry, score: textOverlap(focus, entry.line) }))
      .filter((entry) => entry.score >= THREAD_CONTEXT_RELEVANCE_MIN)
      .sort((left, right) => right.score - left.score);
    for (const entry of relevant) {
      const cost = costs[entry.index] ?? 0;
      if (spent + cost > budget) {
        continue;
      }
      kept.add(entry.index);
      spent += cost;
    }
  }
  const lines = entries.filter((_, index) => kept.has(index));
  return { lines, elided: entries.length - lines.length };
}
