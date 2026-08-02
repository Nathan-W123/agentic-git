import assert from "node:assert/strict";
import test from "node:test";

import {
  WHOLE_FILE,
  normalizeRanges,
  rangesIntersect,
  rangesOverlap,
  subtractRanges,
} from "./ranges.js";

/**
 * The arithmetic a sub-file ownership claim is made of. Every one of these is
 * load-bearing somewhere: `subtractRanges` is how a plan says "the rest of
 * this file", and `rangesIntersect` is what decides whether two claims on one
 * path are a contest at all.
 */

test("adjacent spans normalize into one", () => {
  assert.deepEqual(
    normalizeRanges([
      { startLine: 6, endLine: 10 },
      { startLine: 1, endLine: 5 },
    ]),
    [{ startLine: 1, endLine: 10 }],
  );
});

test("overlapping and nested spans collapse", () => {
  assert.deepEqual(
    normalizeRanges([
      { startLine: 1, endLine: 20 },
      { startLine: 5, endLine: 8 },
      { startLine: 18, endLine: 30 },
    ]),
    [{ startLine: 1, endLine: 30 }],
  );
});

test("spans with a gap between them stay apart", () => {
  assert.deepEqual(
    normalizeRanges([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 9 },
    ]),
    [
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 9 },
    ],
  );
});

test("a reversed or non-integer span is discarded rather than trusted", () => {
  // These come from an index, and an index can be wrong. A span that cannot be
  // read is not a claim; treating it as one would either withhold arbitrary
  // lines or, worse, appear to cover lines it does not.
  assert.deepEqual(
    normalizeRanges([
      { startLine: 10, endLine: 4 },
      { startLine: Number.NaN, endLine: 5 },
      { startLine: 2, endLine: 3 },
    ]),
    [{ startLine: 2, endLine: 3 }],
  );
});

test("intersection is what decides a contest, and touching is enough", () => {
  assert.equal(rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 5, endLine: 9 }), true);
  assert.equal(rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 6, endLine: 9 }), false);
  assert.equal(
    rangesIntersect(
      [{ startLine: 1, endLine: 5 }, { startLine: 40, endLine: 80 }],
      [{ startLine: 70, endLine: 90 }],
    ),
    true,
  );
  assert.equal(
    rangesIntersect(
      [{ startLine: 1, endLine: 5 }, { startLine: 40, endLine: 80 }],
      [{ startLine: 6, endLine: 39 }],
    ),
    false,
  );
});

test("the rest of a file is everything either side of the holder's lines", () => {
  assert.deepEqual(subtractRanges([WHOLE_FILE], [{ startLine: 40, endLine: 80 }]), [
    { startLine: 1, endLine: 39 },
    { startLine: 81, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

test("a claim starting at line one loses only its tail", () => {
  assert.deepEqual(subtractRanges([WHOLE_FILE], [{ startLine: 1, endLine: 20 }]), [
    { startLine: 21, endLine: Number.MAX_SAFE_INTEGER },
  ]);
});

test("two holders cut two holes", () => {
  assert.deepEqual(
    subtractRanges(
      [WHOLE_FILE],
      [
        { startLine: 40, endLine: 60 },
        { startLine: 100, endLine: 120 },
      ],
    ),
    [
      { startLine: 1, endLine: 39 },
      { startLine: 61, endLine: 99 },
      { startLine: 121, endLine: Number.MAX_SAFE_INTEGER },
    ],
  );
});

test("a claim swallowed whole leaves nothing", () => {
  // Not an unrestricted claim: an empty result means there is no narrower
  // claim to make here, and the caller has to fall back on losing the file.
  assert.deepEqual(
    subtractRanges([{ startLine: 10, endLine: 20 }], [{ startLine: 1, endLine: 50 }]),
    [],
  );
});

test("what is subtracted never intersects what is left", () => {
  const held = [
    { startLine: 12, endLine: 18 },
    { startLine: 44, endLine: 44 },
  ];
  const rest = subtractRanges([WHOLE_FILE], held);
  assert.equal(rangesIntersect(rest, held), false);
  // And nothing outside the holder's lines was given away with them.
  assert.equal(rangesIntersect(rest, [{ startLine: 19, endLine: 43 }]), true);
});
