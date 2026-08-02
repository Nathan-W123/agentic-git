import type { LineRange } from "@coord/shared-types";

export type { LineRange };

/**
 * Arithmetic on the line spans an ownership claim is made of.
 *
 * A claim on a file used to be a boolean: the plan named the path or it did
 * not. Once a claim can be *part* of a file, the questions arbitration asks
 * become set questions — do these two claims touch, and what is left of one
 * after the other is taken out of it — so they are answered here rather than
 * open-coded at each of the three places that ask.
 *
 * Everything is 1-based and inclusive, matching {@link LineRange} and the old
 * side of a diff hunk.
 */

/**
 * The claim a plan makes when it names a file outright.
 *
 * Expressed as a span rather than a special case so that "all of it" and "these
 * lines of it" go through the same intersection and subtraction. The end is the
 * largest safe integer rather than a file length, because a file length is not
 * something arbitration knows and does not need: nothing can be past the end of
 * a file, so nothing is lost by treating the tail as claimed.
 */
export const WHOLE_FILE: LineRange = {
  startLine: 1,
  endLine: Number.MAX_SAFE_INTEGER,
};

export function rangesOverlap(first: LineRange, second: LineRange): boolean {
  return first.startLine <= second.endLine && second.startLine <= first.endLine;
}

/**
 * Sorts, drops empty spans, and merges any that touch or overlap.
 *
 * Adjacency counts as overlap: lines 1–5 and 6–10 are one span of 1–10 for
 * every purpose here. Keeping them apart would make two equal claims compare
 * unequal depending on how they were assembled.
 */
export function normalizeRanges(
  ranges: readonly LineRange[],
): LineRange[] {
  const usable = ranges
    .filter(
      (range) =>
        Number.isSafeInteger(range.startLine) &&
        Number.isSafeInteger(range.endLine) &&
        range.endLine >= range.startLine,
    )
    .map((range) => ({
      startLine: Math.max(1, range.startLine),
      endLine: Math.max(1, range.endLine),
    }))
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
  const merged: LineRange[] = [];
  for (const range of usable) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** Whether any span on one side touches any span on the other. */
export function rangesIntersect(
  first: readonly LineRange[],
  second: readonly LineRange[],
): boolean {
  return first.some((left) =>
    second.some((right) => rangesOverlap(left, right)),
  );
}

/**
 * What is left of one set of spans once another is taken out of it.
 *
 * This is how a plan says "the rest of this file": the claim it would have
 * made is {@link WHOLE_FILE}, the holder's spans come out, and what remains is
 * a claim the holder's lease does not intersect. An empty result means nothing
 * of the file was left, which callers must read as "there is no narrower claim
 * to make here" rather than as an unrestricted one.
 */
export function subtractRanges(
  from: readonly LineRange[],
  removed: readonly LineRange[],
): LineRange[] {
  const cuts = normalizeRanges(removed);
  const kept: LineRange[] = [];
  for (const range of normalizeRanges(from)) {
    let start = range.startLine;
    for (const cut of cuts) {
      if (cut.endLine < start || cut.startLine > range.endLine) {
        continue;
      }
      if (cut.startLine > start) {
        kept.push({ startLine: start, endLine: cut.startLine - 1 });
      }
      start = Math.max(start, cut.endLine + 1);
    }
    if (start <= range.endLine) {
      kept.push({ startLine: start, endLine: range.endLine });
    }
  }
  return kept;
}
