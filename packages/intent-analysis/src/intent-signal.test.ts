import assert from "node:assert/strict";
import test from "node:test";

import { cosineSimilarity } from "./embeddings.js";
import {
  analyzeIntentPair,
  DEFAULT_INTENT_SIGNAL_OPTIONS,
} from "./intent-signal.js";

/**
 * A stand-in for the embedding model.
 *
 * These tests are about the decision rule — the gate, the curve, the
 * threshold — not about MiniLM, so the similarity is supplied directly. That
 * also keeps the unit suite free of a 23MB model download, which belongs in
 * the evaluation script and not in `npm test`.
 */
function vectorsFor(similarity: number): [Float32Array, Float32Array] {
  const angle = Math.acos(Math.max(-1, Math.min(1, similarity)));
  return [
    Float32Array.from([1, 0]),
    Float32Array.from([Math.cos(angle), Math.sin(angle)]),
  ];
}

test("the test double produces the similarity it claims", () => {
  const [left, right] = vectorsFor(0.6);
  assert.ok(Math.abs(cosineSimilarity(left, right) - 0.6) < 1e-6);
});

const FEE = "Add a fixed handling charge to every computed order total";
const DELIVERY =
  "Enable free delivery above one hundred pounds and charge three pounds below it";
const WEBHOOK =
  "Retry webhook delivery up to three times when the transport reports a failure";

test("fires on two pricing intents that are both similar and corroborated", () => {
  const [left, right] = vectorsFor(0.7);
  const result = analyzeIntentPair(
    { text: FEE, embedding: left },
    { text: DELIVERY, embedding: right },
  );
  assert.equal(result.fires, true);
  assert.ok(result.sharedTerms.includes("charge"));
  assert.ok(result.probability > 0.5);
});

test("a shared word is not enough without similarity", () => {
  // "delivery" is genuinely shared between a pricing task and a webhook task,
  // and means two unrelated things. This is the pair the corroboration layer
  // gets wrong on its own and the embedding has to veto.
  const [left, right] = vectorsFor(0.2);
  const result = analyzeIntentPair(
    { text: DELIVERY, embedding: left },
    { text: WEBHOOK, embedding: right },
  );
  assert.ok(result.sharedTerms.includes("delivery"));
  assert.equal(result.fires, false);
  assert.equal(result.probability, 0);
});

test("similarity is not enough without corroboration", () => {
  const [left, right] = vectorsFor(0.95);
  const result = analyzeIntentPair(
    { text: "Speed up the nightly reconciliation job", embedding: left },
    { text: "Make weekly ledger balancing quicker", embedding: right },
    { ...DEFAULT_INTENT_SIGNAL_OPTIONS, requireCorroboration: true },
  );
  assert.deepEqual(result.sharedTerms, []);
  assert.equal(result.fires, false);
});

test("scores continuously rather than as a boolean", () => {
  const scores = [0.4, 0.55, 0.7, 0.9].map((similarity) => {
    const [left, right] = vectorsFor(similarity);
    return analyzeIntentPair(
      { text: FEE, embedding: left },
      { text: DELIVERY, embedding: right },
    ).probability;
  });
  for (let index = 1; index < scores.length; index += 1) {
    assert.ok(
      (scores[index] ?? 0) >= (scores[index - 1] ?? 0),
      `expected a non-decreasing score, got ${JSON.stringify(scores)}`,
    );
  }
  assert.ok(new Set(scores).size > 2, "expected more than a two-valued score");
});

test("WordNet opposition raises the score of an otherwise borderline pair", () => {
  const [left, right] = vectorsFor(0.53);
  const plain = analyzeIntentPair(
    { text: "Increase the loyalty discount rate", embedding: left },
    { text: "Change the loyalty discount rate", embedding: right },
  );
  const opposed = analyzeIntentPair(
    { text: "Increase the loyalty discount rate", embedding: left },
    { text: "Decrease the loyalty discount rate", embedding: right },
  );
  assert.deepEqual(opposed.opposition, ["increase", "decrease"]);
  assert.ok(opposed.probability > plain.probability);
});

test("scores zero and explains itself when no embedding is available", () => {
  const result = analyzeIntentPair({ text: FEE }, { text: DELIVERY });
  assert.equal(result.probability, 0);
  assert.equal(result.fires, false);
  assert.match(result.explanation, /no embedding available/u);
  // The lexical half still ran, so the audit trail is not empty.
  assert.ok(result.sharedTerms.length > 0);
});

test("explains which two different words were treated as one thing", () => {
  const [left, right] = vectorsFor(0.7);
  const result = analyzeIntentPair(
    { text: "Add a handling charge to the order total", embedding: left },
    { text: "Add a handling fee to the order sum", embedding: right },
  );
  assert.ok(
    result.sharedTerms.some((term) => term.includes("/")),
    `expected a synonym link in ${JSON.stringify(result.sharedTerms)}`,
  );
  assert.match(result.explanation, /shared intent terms/u);
});
