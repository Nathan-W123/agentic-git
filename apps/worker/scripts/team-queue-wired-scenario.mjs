/**
 * `team-queue`, with the partial band actually wired to the caller.
 *
 * The original scenario documents its middle band as three tasks that "each
 * own a different pricing module that `total.js` imports". That is true of
 * `task_loyalty_tier` (`src/pricing/discount.js`) and `task_zero_rated_goods`
 * (`src/pricing/tax.js`). It is false of `task_rounding`, whose module is
 * `src/format/money.js` — which nothing imports. The band description and the
 * seed disagree, and the seed wins: with no edge into the caller, there is
 * nothing for a rounding task to own there, and every recorded agent duly
 * implemented rounding inside `orderTotal` instead.
 *
 * The cost of that is measured in `docs/benchmarks/intent-grounding.md`. All
 * three held-out false positives are `task_rounding` pairs, and they are
 * genuinely false — the recorded changesets confirm that rounding, in
 * `total.js`, did not collide with loyalty, in `discount.js`. The label is
 * right and the fixture is wrong, which is the awkward combination: nothing
 * about the *measurement* can be corrected, because the thing that needs
 * fixing is the tree the agents were given.
 *
 * So this is a sibling rather than an edit. `team-queue` stays exactly as
 * recorded — `assertRegisteredSeed` enforces that, and every number in the
 * benchmark docs stays reproducible. This scenario is what a *future* run
 * should use, and it differs in one respect: `orderTotal` rounds its result
 * through a helper that `src/format/money.js` owns, so all three partial-band
 * modules are imported by the caller and the band means what it says.
 *
 * Task ids, objectives and agent assignment are unchanged, so the registered
 * agent-id split in `intent-holdout.mjs` applies to runs of this scenario
 * without being re-drawn.
 */

import { createHash } from "node:crypto";

import { TEAM_QUEUE_SCENARIO } from "./team-queue-scenario.mjs";
import { assertRegisteredSeed } from "./intent-holdout.mjs";

// This seed is defined as a diff against the registered one. If the base ever
// changes, the overrides below may no longer apply to what they assume.
assertRegisteredSeed(TEAM_QUEUE_SCENARIO.seed, createHash);

/**
 * The three files that differ, and why each one does.
 *
 * `money.js` gains `roundMoney`, which is the thing `task_rounding` owns. It
 * rounds to whole *pounds* at the base revision — that is the bug the task
 * exists to fix, and it has to be a real defect rather than a placeholder or
 * the task would have nothing to change.
 *
 * `total.js` imports it and rounds its result through it. That single edge is
 * the entire correction: it is what makes `money.js` a module the caller
 * reads, which is what the partial band always claimed of it.
 *
 * `test/money.test.js` covers the helper without asserting the number of
 * places, because the task under test is precisely the change from one to the
 * other and a test that pinned it would fail the moment the work landed.
 */
const OVERRIDES = {
  "src/format/money.js": `/** How many decimal places a customer-facing amount keeps. */
const PLACES = 0;

/** Rounds an amount to the precision a customer is shown. */
export function roundMoney(amount) {
  const scale = 10 ** PLACES;
  return Math.round(amount * scale) / scale;
}

/** Renders an amount as a customer-facing string. */
export function formatMoney(amount) {
  return \`£\${roundMoney(amount).toFixed(2)}\`;
}
`,

  "src/pricing/total.js": `import { discountRate } from "./discount.js";
import { taxFor } from "./tax.js";
import { roundMoney } from "../format/money.js";

const DELIVERY = 3;

/**
 * What a customer pays for an order.
 *
 * Everything that affects the amount is combined here: line items, the
 * customer's discount, delivery, and tax. The result is rounded to the
 * precision a customer is shown, which \`../format/money.js\` owns.
 */
export function orderTotal(order) {
  const lines = order.lines.reduce(
    (sum, line) => sum + line.price * line.quantity,
    0,
  );
  const discounted = lines * (1 - discountRate(order.customer));
  const withDelivery = discounted + DELIVERY;
  return roundMoney(withDelivery + taxFor(withDelivery, order));
}
`,

  "test/money.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { formatMoney, roundMoney } from "../src/format/money.js";

test("money renders with a currency symbol", () => {
  assert.match(formatMoney(12.5), /£/u);
});

// Deliberately does not assert how many places are kept: changing that is the
// work, and a test that pinned it would fail the moment the task landed.
test("rounding leaves a positive amount positive and never grows it much", () => {
  const rounded = roundMoney(12.344);
  assert.equal(Number.isFinite(rounded), true);
  assert.equal(rounded > 0, true);
  assert.equal(Math.abs(rounded - 12.344) < 1, true);
});
`,
};

const SEED = { ...TEAM_QUEUE_SCENARIO.seed, ...OVERRIDES };

for (const file of Object.keys(OVERRIDES)) {
  if (!(file in TEAM_QUEUE_SCENARIO.seed)) {
    throw new Error(`override ${file} does not exist in the base seed`);
  }
}

export const TEAM_QUEUE_WIRED_SCENARIO = {
  ...TEAM_QUEUE_SCENARIO,
  name: "team-queue-wired",
  description:
    TEAM_QUEUE_SCENARIO.description +
    " The partial band's three modules are all imported by the order total, " +
    "including the rounding helper — which team-queue left unreferenced.",
  seed: SEED,
};

/** Unchanged from `team-queue`: same ids, same bands, same agents. */
export { TEAM_QUEUE_BANDS as TEAM_QUEUE_WIRED_BANDS } from "./team-queue-scenario.mjs";
export { TEAM_QUEUE_TRUE_CONFLICTS as TEAM_QUEUE_WIRED_TRUE_CONFLICTS } from "./team-queue-scenario.mjs";
