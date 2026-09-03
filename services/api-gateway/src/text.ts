/**
 * Text primitives shared by everything that reads a channel back to a model.
 *
 * These are here rather than beside their first caller because four separate
 * concerns - thread context, the channel memo, audit summaries and claim
 * scoring - all need the same answer to "what does this text say", and two
 * copies of `collapseWhitespace` that drift is a class of bug nobody notices
 * until a thread reads back wrong in one place and right in another.
 */

/** Mirrors `firstWord` in `apps/web/public/data.js`. */
export function firstWord(name: string): string {
  return String(name ?? "").trim().split(/\s+/u)[0] || "Teammate";
}

/**
 * One channel line as a single line, for the two places a thread is read back
 * to a model — answering a follow-up, and carrying the thread into a task.
 * Both send one entry per bullet, so an entry that wraps over several lines
 * would otherwise read as several entries.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * How alike two pieces of channel text are, 0 to 1.
 *
 * Jaccard over the same stopword-stripped tokens agent matching uses, so
 * "similar" means one thing in this system rather than two. Symmetric on
 * purpose: a short follow-up about a long thread should not score highly just
 * because the thread contains every word it used.
 */
export function textOverlap(left: string, right: string): number {
  const a = relevanceTokens(left);
  const b = relevanceTokens(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

/** Common words that carry no relevance signal, stripped before scoring. */
export const RELEVANCE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
  "is", "are", "can", "could", "would", "we", "you", "your", "please",
  "hey", "hi", "this", "that", "it", "be", "as", "at", "by", "our", "us",
  "someone", "anybody", "anyone", "who", "what", "when", "where", "why",
  "how", "just", "also", "really", "its", "was", "were", "not", "so",
]);

/**
 * Lowercased, punctuation-stripped, stopword-filtered token set for
 * matching a message against a candidate's role/name text or a past
 * objective. Single-character tokens are dropped as noise; two-character
 * ones are kept deliberately ("ui", "db", "ci" all carry real signal for
 * this).
 */
export function relevanceTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((word) => word.length > 1 && !RELEVANCE_STOPWORDS.has(word)),
  );
}
