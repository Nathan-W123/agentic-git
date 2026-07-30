import assert from "node:assert/strict";
import test from "node:test";

import {
  dividePatchByRanges,
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

/**
 * Dividing a patch at a withheld line range.
 *
 * The correctness that matters is not tested here but in
 * `scripts/verify-patch-division.mjs`, which applies both halves with real git
 * and checks the result equals the undivided patch. What these cover is the
 * arithmetic that script would only catch by accident, and the refusals.
 */

const WITHHELD_TEN_TO_TWENTY = [{ startLine: 10, endLine: 20 }];

test("hunks are sorted by whether they reach the withheld lines", () => {
  const division = dividePatchByRanges(
    patch(
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -12,2 +12,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -40,2 +40,2 @@",
      " keep",
      "-old",
      "+new",
    ),
    WITHHELD_TEN_TO_TWENTY,
  );
  assert.equal(division?.grantedHunks, 2);
  assert.equal(division?.deferredHunks, 1);
  assert.match(division?.granted ?? "", /@@ -1,2/u);
  assert.match(division?.granted ?? "", /@@ -40,2/u);
  assert.doesNotMatch(division?.granted ?? "", /@@ -12,2/u);
  assert.match(division?.deferred ?? "", /@@ -12,2/u);
});

test("the new side is renumbered for the hunks that were dropped", () => {
  // The first hunk deletes two lines. In the whole patch the second hunk lands
  // at new line 38; with the first hunk held back it lands at 40, because the
  // deletion that shifted it is no longer part of this patch.
  const division = dividePatchByRanges(
    patch(
      "@@ -12,4 +12,2 @@",
      " keep",
      "-gone",
      "-gone",
      " keep",
      "@@ -40,2 +38,2 @@",
      " keep",
      "-old",
      "+new",
    ),
    WITHHELD_TEN_TO_TWENTY,
  );
  assert.match(division?.granted ?? "", /@@ -40,2 \+40,2 @@/u);
  // The deferred half is first in its own patch, so it keeps its numbering.
  assert.match(division?.deferred ?? "", /@@ -12,4 \+12,2 @@/u);
});

test("a granted hunk that adds lines shifts the ones after it", () => {
  const division = dividePatchByRanges(
    patch(
      "@@ -1,2 +1,4 @@",
      " keep",
      "+added",
      "+added",
      " keep",
      "@@ -12,2 +14,2 @@",
      " keep",
      "-old",
      "+new",
      "@@ -40,2 +42,2 @@",
      " keep",
      "-old",
      "+new",
    ),
    WITHHELD_TEN_TO_TWENTY,
  );
  // Granted keeps hunks one and three: the third still moves by the two lines
  // the first adds, so its new start stays 42.
  assert.match(division?.granted ?? "", /@@ -1,2 \+1,4 @@/u);
  assert.match(division?.granted ?? "", /@@ -40,2 \+42,2 @@/u);
});

test("a pure insertion keeps git's off-by-one when it is re-emitted", () => {
  const division = dividePatchByRanges(
    patch("@@ -12,1 +12,1 @@", "-old", "+new", "@@ -30,0 +30,1 @@", "+added"),
    WITHHELD_TEN_TO_TWENTY,
  );
  assert.match(division?.granted ?? "", /@@ -30,0 \+31,1 @@/u);
});

test("a patch with nothing outside the withheld lines is not divided", () => {
  // Both halves must be real for a division to be worth anything; one empty
  // side means the caller's existing all-or-nothing answer is already right.
  const division = dividePatchByRanges(
    patch("@@ -12,2 +12,2 @@", " keep", "-old", "+new"),
    WITHHELD_TEN_TO_TWENTY,
  );
  assert.equal(division?.granted, undefined);
  assert.equal(division?.deferredHunks, 1);
});

test("a section heading survives the round trip", () => {
  const division = dividePatchByRanges(
    patch(
      "@@ -1,2 +1,2 @@ function alpha() {",
      " keep",
      "-old",
      "+new",
      "@@ -12,2 +12,2 @@ function withheld() {",
      " keep",
      "-old",
      "+new",
    ),
    WITHHELD_TEN_TO_TWENTY,
  );
  assert.match(division?.granted ?? "", /@@ function alpha\(\) \{/u);
  assert.match(division?.deferred ?? "", /@@ function withheld\(\) \{/u);
});

test("a no-newline marker makes a patch indivisible", () => {
  // The marker's meaning depends on the hunk being the file's last, and
  // dropping a sibling can change that.
  assert.equal(
    dividePatchByRanges(
      patch(
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "@@ -12,1 +12,1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
      ),
      WITHHELD_TEN_TO_TWENTY,
    ),
    undefined,
  );
});

test("a header whose counts do not match its body is refused", () => {
  // The signature of a misparse. Re-emitting it would produce a patch that
  // applies somewhere other than where it says.
  assert.equal(
    dividePatchByRanges(
      patch("@@ -1,9 +1,9 @@", " keep", "-old", "+new"),
      WITHHELD_TEN_TO_TWENTY,
    ),
    undefined,
  );
});

test("a binary patch is refused rather than guessed at", () => {
  assert.equal(
    dividePatchByRanges(
      [
        "diff --git a/src/a.bin b/src/a.bin",
        "index 1111111..2222222 100644",
        "GIT binary patch",
        "literal 4",
        "Lc$@(#0000",
        "",
      ].join("\n"),
      WITHHELD_TEN_TO_TWENTY,
    ),
    undefined,
  );
});

test("a patch covering two files is refused", () => {
  // This divider re-emits one preamble; a second file's header would be
  // silently dropped or duplicated.
  assert.equal(
    dividePatchByRanges(
      patch(
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -12,1 +12,1 @@",
        "-old",
        "+new",
      ),
      WITHHELD_TEN_TO_TWENTY,
    ),
    undefined,
  );
});

test("withholding nothing divides nothing", () => {
  assert.equal(
    dividePatchByRanges(patch("@@ -1,1 +1,1 @@", "-old", "+new"), []),
    undefined,
  );
});

test("the git preamble is carried onto both halves", () => {
  const division = dividePatchByRanges(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "@@ -12,1 +12,1 @@",
      "-old",
      "+new",
    ].join("\n"),
    WITHHELD_TEN_TO_TWENTY,
  );
  // The preimage blob is what `git apply --3way` reconstructs from, and both
  // halves share it: they are written against the same base revision.
  for (const half of [division?.granted, division?.deferred]) {
    assert.match(half ?? "", /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/mu);
    assert.match(half ?? "", /^index 1111111/mu);
    assert.match(half ?? "", /^--- a\/src\/a\.ts$/mu);
  }
});
