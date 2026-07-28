/**
 * Reading a patch for what it touched, rather than for what it says.
 *
 * File-level enforcement can be done from a patch's path alone. Anything finer
 * has to look inside, and the only durable coordinate a diff carries is the
 * old-side hunk header — the lines the patch was written against. Those are
 * base-revision line numbers, which is exactly the coordinate system the
 * repository index records symbol positions in, so the two can be compared
 * without re-reading the file.
 */

export interface LineRange {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

/**
 * `@@ -oldStart,oldLines +newStart,newLines @@`, with the counts optional.
 * Only the old side is read: it is the side that exists at the base revision.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u;

/**
 * The base-revision lines a patch changes.
 *
 * The hunk header alone is too coarse to use: it spans the context lines a
 * diff carries either side of a change, so an edit three lines above a
 * function would read as an edit to the function. The body is walked instead,
 * counting old lines as it goes, and only the lines actually removed or
 * inserted at are recorded.
 *
 * An insertion has no old line of its own, so it is attributed to the lines on
 * either side of where it lands. Code inserted immediately after a declaration
 * is a change to that declaration in every sense that matters here, and where
 * there is a choice the conservative reading is the one taken.
 */
export function patchedLineRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  let oldLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      const start = Number.parseInt(match[1] ?? "", 10);
      const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      inHunk = Number.isSafeInteger(start) && Number.isSafeInteger(count);
      // A hunk declaring no old lines is a pure insertion, and git numbers it
      // by the line *before* the insertion point rather than the first line
      // covered. Advancing by one puts the counter back on the same footing as
      // every other hunk, so the body walk below needs no special case.
      oldLine = count === 0 ? start + 1 : start;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      // "\ No newline at end of file" annotates the previous line rather than
      // being one of its own.
      continue;
    }
    if (line.startsWith("-")) {
      ranges.push({ startLine: oldLine, endLine: oldLine });
      oldLine += 1;
    } else if (line.startsWith("+")) {
      ranges.push({
        startLine: Math.max(1, oldLine - 1),
        endLine: Math.max(1, oldLine),
      });
    } else if (line.startsWith(" ") || line.length === 0) {
      oldLine += 1;
    } else {
      // Anything else ends the body — the next file's header, most often.
      inHunk = false;
    }
  }
  return ranges;
}

export function rangesOverlap(first: LineRange, second: LineRange): boolean {
  return (
    first.startLine <= second.endLine && second.startLine <= first.endLine
  );
}

export interface NamedRange extends LineRange {
  name: string;
}

/**
 * Which of `candidates` a patch reaches into, given where they live.
 *
 * `undefined` ranges mean the file could not be parsed. The answer is then
 * every candidate: a file nothing can be located inside is treated as though
 * the patch touched all of it, so a withheld symbol is never let through on a
 * guess. A candidate with no range in this file is simply not in this file,
 * and is not reported.
 */
export function namesTouchedByPatch(
  patch: string,
  ranges: readonly NamedRange[] | undefined,
  candidates: readonly string[],
): string[] {
  const wanted = new Set(candidates);
  if (ranges === undefined) {
    return [...wanted].sort();
  }
  const hunks = patchedLineRanges(patch);
  return [
    ...new Set(
      ranges
        .filter(
          (range) =>
            wanted.has(range.name) &&
            hunks.some((hunk) => rangesOverlap(hunk, range)),
        )
        .map((range) => range.name),
    ),
  ].sort();
}
