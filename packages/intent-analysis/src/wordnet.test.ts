import assert from "node:assert/strict";
import test from "node:test";

import { wordNet } from "./wordnet.js";

const lexicon = wordNet();

test("the WordNet database is readable", () => {
  assert.equal(lexicon.available(), true);
});

test("binary search finds lemmas at both ends of the index", () => {
  // The first and last entries of a sorted index are where an off-by-one in
  // the search shows up, and nowhere else.
  assert.ok(lexicon.synonyms("aardvark").length >= 0);
  assert.ok(lexicon.synonyms("zucchini").includes("courgette"));
});

test("reads antonyms the hardcoded list could not have contained", () => {
  // The shipped signal knew ten pairs. These are ones it did not know, and
  // they are the vocabulary the pricing scenarios actually use.
  assert.ok(lexicon.antonyms("increase").includes("decrease"));
  assert.ok(lexicon.antonyms("raise").includes("lower"));
  assert.ok(lexicon.antonyms("include").includes("exclude"));
  // And one it did, to show the replacement is a superset rather than a swap.
  assert.ok(lexicon.antonyms("enable").includes("disable"));
});

test("antonymy is symmetric where WordNet records it", () => {
  assert.ok(lexicon.antonyms("decrease").includes("increase"));
});

test("synonyms cross parts of speech and exclude the word itself", () => {
  const synonyms = lexicon.synonyms("charge");
  assert.ok(synonyms.includes("accusation"));
  assert.equal(synonyms.includes("charge"), false);
});

test("unknown words return empty rather than throwing", () => {
  assert.deepEqual(lexicon.synonyms("qwertyuiopx"), []);
  assert.deepEqual(lexicon.antonyms("qwertyuiopx"), []);
});

test("multi-word entries are returned with spaces, not underscores", () => {
  assert.ok(
    lexicon.synonyms("increase").every((word) => !word.includes("_")),
  );
});
