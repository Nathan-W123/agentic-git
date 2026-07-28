import assert from "node:assert/strict";
import test from "node:test";

import {
  namesTouchedByPatch,
  patchedLineRanges,
  rangesOverlap,
} from "./hunks.js";

/**
 * Reading a diff for the base-revision lines it changed. This is the only
 * thing standing behind a withheld symbol, so it has to be both accurate —
 * context lines are not changes — and conservative where it cannot be sure.
 */

function patch(...body: string[]): string {
  return ["--- a/src/a.ts", "+++ b/src/a.ts", ...body].join("\n");
}

test("context lines are not changes", () => {
  // The whole reason the body is walked. A one-line edit carries three lines
  // of context either side; reading the header alone would call all seven of
  // them touched, and an edit near a function would read as an edit to it.
  assert.deepEqual(
    patchedLineRanges(
      patch(
        "@@ -1,5 +1,5 @@",
        "-const a = 1;",
        "+const a = 2;",
        " ",
        " function far() {",
        "   return a;",
        " }",
      ),
    ),
    [
      // The removed line, then the replacement attributed to the lines either
      // side of where it lands. Lines 4 to 7 are context and go unclaimed.
      { startLine: 1, endLine: 1 },
      { startLine: 1, endLine: 2 },
    ],
  );
});

test("a removal is attributed to the line it removed", () => {
  assert.deepEqual(
    patchedLineRanges(patch("@@ -10,3 +10,2 @@", " keep", "-gone", " keep")),
    [{ startLine: 11, endLine: 11 }],
  );
});

test("an insertion is attributed to the lines it lands between", () => {
  // It has no old line of its own. Code inserted straight after a declaration
  // is a change to that declaration, so both sides are claimed.
  assert.deepEqual(
    patchedLineRanges(patch("@@ -10,2 +10,3 @@", " keep", "+added", " keep")),
    [{ startLine: 10, endLine: 11 }],
  );
});

test("a pure insertion hunk is numbered from the line before it", () => {
  // git writes `-20,0` for an insertion after old line 20.
  assert.deepEqual(
    patchedLineRanges(patch("@@ -20,0 +21,1 @@", "+added")),
    [{ startLine: 20, endLine: 21 }],
  );
  // An insertion at the top of the file cannot claim line zero.
  assert.deepEqual(patchedLineRanges(patch("@@ -0,0 +1,1 @@", "+added")), [
    { startLine: 1, endLine: 1 },
  ]);
});

test("every hunk in a multi-hunk patch is walked", () => {
  assert.deepEqual(
    patchedLineRanges(
      patch(
        "@@ -3,2 +3,2 @@",
        "-old",
        "+new",
        "@@ -30,2 +30,2 @@",
        " keep",
        "-old",
        "+new",
      ),
    ),
    [
      { startLine: 3, endLine: 3 },
      { startLine: 3, endLine: 4 },
      { startLine: 31, endLine: 31 },
      { startLine: 31, endLine: 32 },
    ],
  );
});

test("a body line that only looks like a header is not one", () => {
  // Diff bodies carry arbitrary text, including text from other diffs.
  assert.deepEqual(
    patchedLineRanges(
      patch(
        "@@ -3,1 +3,2 @@",
        "+// documented as @@ -999,9 +999,9 @@ in the changelog",
        " keep",
      ),
    ),
    [{ startLine: 2, endLine: 3 }],
  );
});

test("a no-newline marker annotates rather than counts", () => {
  assert.deepEqual(
    patchedLineRanges(
      patch("@@ -1,1 +1,1 @@", "-old", "\\ No newline at end of file", "+new"),
    ),
    [
      { startLine: 1, endLine: 1 },
      { startLine: 1, endLine: 2 },
    ],
  );
});

test("overlap is inclusive at both ends", () => {
  const range = { startLine: 10, endLine: 20 };
  assert.equal(rangesOverlap({ startLine: 20, endLine: 25 }, range), true);
  assert.equal(rangesOverlap({ startLine: 5, endLine: 10 }, range), true);
  assert.equal(rangesOverlap({ startLine: 21, endLine: 25 }, range), false);
  assert.equal(rangesOverlap({ startLine: 5, endLine: 9 }, range), false);
});

const RANGES = [
  { name: "alpha", startLine: 1, endLine: 5 },
  { name: "withheld", startLine: 10, endLine: 20 },
];

const EDIT_AT_LINE_TWO = patch(
  "@@ -1,4 +1,4 @@",
  " keep",
  "-old",
  "+new",
  " keep",
  " keep",
);

const EDIT_INSIDE_WITHHELD = patch(
  "@@ -11,3 +11,3 @@",
  " keep",
  "-old",
  "+new",
  " keep",
);

test("a patch that stays clear of a withheld symbol does not touch it", () => {
  assert.deepEqual(namesTouchedByPatch(EDIT_AT_LINE_TWO, RANGES, ["withheld"]), []);
});

test("a patch reaching into a withheld symbol is reported", () => {
  assert.deepEqual(
    namesTouchedByPatch(EDIT_INSIDE_WITHHELD, RANGES, ["withheld"]),
    ["withheld"],
  );
});

test("a file nothing can be located inside counts as touching everything", () => {
  // Unparsed file, withheld symbol: there is no way to tell, so the answer is
  // the one that cannot let an edit through.
  assert.deepEqual(
    namesTouchedByPatch(EDIT_AT_LINE_TWO, undefined, ["withheld", "other"]),
    ["other", "withheld"],
  );
});

test("a symbol that does not live in this file is not touched by it", () => {
  assert.deepEqual(
    namesTouchedByPatch(EDIT_AT_LINE_TWO, RANGES, ["elsewhere"]),
    [],
  );
});
