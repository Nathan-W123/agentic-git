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

import { rangesOverlap, type LineRange } from "./ranges.js";

export { rangesOverlap, type LineRange };

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

/**
 * One hunk of a unified diff, kept whole.
 *
 * The old side is authoritative and travels unchanged: it is measured against
 * the base revision, which does not move when a sibling hunk is dropped. The
 * new side is not, so `newStart` is deliberately not kept — it is recomputed
 * on re-emission from whichever hunks survived.
 */
interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  /** Whatever followed the closing `@@`, usually a section heading. */
  heading: string;
  body: string[];
}

interface ParsedPatch {
  /** `diff --git`, `index`, `---`, `+++` — everything before the first hunk. */
  preamble: string[];
  hunks: ParsedHunk[];
  trailingNewline: boolean;
}

/**
 * A patch broken into hunks, or `undefined` when it is not safe to break.
 *
 * The bar is deliberately high, because the output is re-emitted as a patch
 * that git must apply: anything not recognised as a plain single-file
 * modification is refused rather than guessed at. Refusing costs the caller
 * nothing but coarseness — it falls back to handling the patch whole, which is
 * what it did before this existed.
 */
function parseUnifiedPatch(patch: string): ParsedPatch | undefined {
  const trailingNewline = patch.endsWith("\n");
  const lines = (trailingNewline ? patch.slice(0, -1) : patch).split("\n");
  const preamble: string[] = [];
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | undefined;

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      const oldStart = Number.parseInt(match[1] ?? "", 10);
      const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(oldCount)) {
        return undefined;
      }
      current = {
        oldStart,
        oldCount,
        newCount: 0,
        heading: line.slice(line.indexOf("@@", 2) + 2),
        body: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      preamble.push(line);
      continue;
    }
    // "\ No newline at end of file" makes a hunk's meaning depend on whether
    // it is the last one in the file. Dropping a sibling can change that, so
    // any patch carrying the marker is handled whole.
    if (line.startsWith("\\")) {
      return undefined;
    }
    if (
      !line.startsWith(" ") &&
      !line.startsWith("+") &&
      !line.startsWith("-") &&
      line.length > 0
    ) {
      // A second file's header, or something this parser does not understand.
      return undefined;
    }
    current.body.push(line);
  }

  if (hunks.length === 0) {
    return undefined;
  }
  // The headers are checked against the bodies rather than trusted. A count
  // that does not match is the signature of a misparse, and a misparse here
  // would be re-emitted as a patch that quietly applies in the wrong place.
  for (const hunk of hunks) {
    let oldLines = 0;
    let newLines = 0;
    for (const line of hunk.body) {
      if (line.startsWith("-")) {
        oldLines += 1;
      } else if (line.startsWith("+")) {
        newLines += 1;
      } else {
        oldLines += 1;
        newLines += 1;
      }
    }
    if (oldLines !== hunk.oldCount) {
      return undefined;
    }
    hunk.newCount = newLines;
  }
  return { preamble, hunks, trailingNewline };
}

/**
 * Re-emits a subset of a patch's hunks as a patch in its own right.
 *
 * The old side needs no adjustment; the new side does. A hunk's `newStart` is
 * where it lands in the file *after* every earlier hunk has been applied, so
 * dropping one shifts every hunk after it by the number of lines that hunk
 * would have added or removed. Tracking that running delta is the whole of it,
 * bar git's two off-by-one conventions: a hunk that adds to the old side
 * without deleting from it is numbered from the line before the insertion
 * point, and a hunk that deletes without adding is numbered from the line
 * before the deletion in the new file.
 */
function emitPatch(parsed: ParsedPatch, hunks: readonly ParsedHunk[]): string {
  const lines = [...parsed.preamble];
  let delta = 0;
  for (const hunk of hunks) {
    const newStart =
      hunk.oldCount === 0
        ? hunk.oldStart + delta + 1
        : hunk.newCount === 0
          ? Math.max(0, hunk.oldStart + delta - 1)
          : hunk.oldStart + delta;
    lines.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} ` +
        `+${String(newStart)},${String(hunk.newCount)} @@${hunk.heading}`,
    );
    lines.push(...hunk.body);
    delta += hunk.newCount - hunk.oldCount;
  }
  const text = lines.join("\n");
  return parsed.trailingNewline ? `${text}\n` : text;
}

export interface PatchDivision {
  /** The hunks clear of every withheld range. Absent when none are. */
  granted?: string;
  /** The hunks that reach into a withheld range. Absent when none do. */
  deferred?: string;
  grantedHunks: number;
  deferredHunks: number;
}

/**
 * Divides a patch into the part that stays clear of some withheld lines and
 * the part that does not.
 *
 * This is the difference between "the agent touched something it does not own"
 * costing it a file and costing it a hunk. Both halves are complete patches
 * against the same base revision, so the granted half applies exactly as it
 * would have inside the whole — no hunk is rewritten, only renumbered on the
 * side that renumbering is defined for.
 *
 * `undefined` means the patch could not be divided safely and the caller must
 * decide about it whole. That is the honest answer for a patch this parser
 * does not fully recognise: half a diff that reads like a diff and applies
 * like nothing is worse than a coarse decision.
 *
 * What this does *not* claim is that the granted half is meaningful on its
 * own. Hunks are not independent — a rename in one and its call sites in
 * another are one change — so a division can produce a granted half that does
 * not build. That is caught where every other broken changeset is caught: the
 * granted half is validated transactionally before promotion, and a failure
 * leaves canonical untouched and requeues the task.
 */
export function dividePatchByRanges(
  patch: string,
  withheld: readonly LineRange[],
): PatchDivision | undefined {
  if (withheld.length === 0) {
    return undefined;
  }
  const parsed = parseUnifiedPatch(patch);
  if (parsed === undefined) {
    return undefined;
  }
  const granted: ParsedHunk[] = [];
  const deferred: ParsedHunk[] = [];
  for (const hunk of parsed.hunks) {
    // The same body walk the whole-patch reader does, so a hunk is judged by
    // the lines it actually changes rather than by the context it carries.
    const touched = patchedLineRanges(
      emitPatch({ ...parsed, preamble: [], trailingNewline: false }, [hunk]),
    );
    const reaches = touched.some((range) =>
      withheld.some((held) => rangesOverlap(range, held)),
    );
    (reaches ? deferred : granted).push(hunk);
  }
  return {
    ...(granted.length === 0 ? {} : { granted: emitPatch(parsed, granted) }),
    ...(deferred.length === 0 ? {} : { deferred: emitPatch(parsed, deferred) }),
    grantedHunks: granted.length,
    deferredHunks: deferred.length,
  };
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
