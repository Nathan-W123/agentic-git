/**
 * Taking a unified diff apart and putting a subset of it back together.
 *
 * This lives here, next to git, rather than in the coordinator that first
 * needed it: integration also has to divide a patch — when a changeset
 * conflicts, the hunks that still apply are worth keeping — and the
 * coordinator depends on integration, so the shared piece has to sit below
 * both. There is deliberately one implementation, because a second one that
 * re-emitted hunks slightly differently would produce patches that apply in
 * the wrong place.
 */

/**
 * `@@ -oldStart,oldLines +newStart,newLines @@`, with the counts optional.
 * Only the old side is read: it is the side that exists at the base revision.
 */
export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u;

/**
 * One hunk of a unified diff, kept whole.
 *
 * The old side is authoritative and travels unchanged: it is measured against
 * the base revision, which does not move when a sibling hunk is dropped. The
 * new side is not, so `newStart` is deliberately not kept — it is recomputed
 * on re-emission from whichever hunks survived.
 */
export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  /** Whatever followed the closing `@@`, usually a section heading. */
  heading: string;
  body: string[];
}

export interface ParsedPatch {
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
export function parseUnifiedPatch(patch: string): ParsedPatch | undefined {
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
export function emitPatch(
  parsed: ParsedPatch,
  hunks: readonly ParsedHunk[],
): string {
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
