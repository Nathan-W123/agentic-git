import assert from "node:assert/strict";
import test from "node:test";

import { intentTerms, lemmaOf } from "./lemmas.js";

test("reduces the inflections that defeated exact token matching", () => {
  // Every one of these is a real mismatch from the team-queue intents: the
  // shipped signal compared raw tokens and so saw two different words.
  assert.equal(lemmaOf("orders"), "order");
  assert.equal(lemmaOf("charges"), "charge");
  assert.equal(lemmaOf("charging"), "charge");
  assert.equal(lemmaOf("totals"), "total");
  assert.equal(lemmaOf("higher"), "high");
});

test("leaves words that are already lemmas alone", () => {
  for (const word of ["order", "tax", "delivery", "discount", "webhook"]) {
    assert.equal(lemmaOf(word), word);
  }
});

test("drops the boilerplate every agent intent shares", () => {
  const { strong } = intentTerms(
    "Add a fixed handling charge to every computed order total without " +
      "removing existing discount behavior.",
  );
  for (const boilerplate of ["add", "existing", "behavior", "without"]) {
    assert.equal(strong.has(boilerplate), false);
  }
  for (const content of ["charge", "order", "total", "discount"]) {
    assert.equal(strong.has(content), true);
  }
});

test("keeps a compound and its parts", () => {
  const { strong } = intentTerms("Capture the IP-address on each audit entry");
  assert.equal(strong.has("ip-address"), true);
  assert.equal(strong.has("address"), true);
});

test("generic nouns are lemmas but not corroborating terms", () => {
  const { lemmas, strong } = intentTerms("Change the result of the function");
  assert.equal(lemmas.has("result"), true);
  assert.equal(strong.has("result"), false);
});
