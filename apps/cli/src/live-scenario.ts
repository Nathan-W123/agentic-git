import type { ValidationCommand } from "@coord/shared-types";

import type { BenchmarkScenario, ScenarioTask } from "./scenarios.js";

/**
 * Declared here rather than imported from `scenarios.ts`.
 *
 * That module imports this one to register the scenario, so reading a value
 * from it during module evaluation would be a cycle: the constant is still
 * uninitialised when these tasks are built.
 */
const VALIDATION_COMMANDS: ValidationCommand[] = [
  { executable: "node", args: ["--test"], label: "repository tests" },
];

/**
 * A benchmark scenario intended for real agents.
 *
 * The synthetic scenarios exist to make the coordinator deterministic. This one
 * exists to measure the opposite: what happens when the agent is real and its
 * behavior is not known in advance.
 *
 * Two properties matter for the measurement to be fair.
 *
 * The objectives never name a file. Naming paths leaks the answer, which both
 * flatters plan accuracy and makes overlap detection trivially correct; here
 * the overlap has to be discovered by the agents themselves.
 *
 * The repository is a small but genuinely structured module tree with passing
 * tests, so validation is a real gate rather than a formality.
 */

const PACKAGE_JSON = `${JSON.stringify(
  { name: "orders", private: true, type: "module" },
  undefined,
  2,
)}\n`;

const SEED: Record<string, string> = {
  "package.json": PACKAGE_JSON,

  "src/pricing/tax.js": `export const TAX_RATE = 0.2;

export function taxFor(amount) {
  return amount * TAX_RATE;
}
`,

  "src/pricing/discount.js": `export function discountRate(customer) {
  return customer.orders > 10 ? 0.1 : 0;
}

export function applyDiscount(amount, rate) {
  return amount - amount * rate;
}
`,

  // The module every pricing change has to pass through. Nothing in the task
  // objectives says so; the agents have to work it out.
  "src/pricing/total.js": `import { applyDiscount, discountRate } from "./discount.js";
import { taxFor } from "./tax.js";

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

export function orderTotal(customer, lines) {
  const base = subtotal(lines);
  const discounted = applyDiscount(base, discountRate(customer));
  return discounted + taxFor(discounted);
}
`,

  "src/models/order.js": `let counter = 0;

export function createOrder(customer, lines) {
  counter += 1;
  return { id: "order_" + counter, customer, lines, status: "open" };
}
`,

  "src/models/customer.js": `export function createCustomer(name) {
  return { name, orders: 0 };
}
`,

  "src/format/currency.js": `export function formatPrice(amount) {
  return "£" + amount.toFixed(2);
}
`,

  "src/format/summary.js": `import { formatPrice } from "./currency.js";

export function formatOrder(order, total) {
  const lines = order.lines.map(
    (line) => line.quantity + " x " + line.name,
  );
  return lines.join("\\n") + "\\nTotal: " + formatPrice(total);
}
`,

  "src/index.js": `export { subtotal, orderTotal } from "./pricing/total.js";
export { taxFor, TAX_RATE } from "./pricing/tax.js";
export { discountRate, applyDiscount } from "./pricing/discount.js";
export { createOrder } from "./models/order.js";
export { createCustomer } from "./models/customer.js";
export { formatPrice } from "./format/currency.js";
export { formatOrder } from "./format/summary.js";
`,

  "test/pricing.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { subtotal, orderTotal, createCustomer } from "../src/index.js";

const lines = [{ name: "Book", price: 10, quantity: 2 }];

test("subtotal sums the lines", () => {
  assert.equal(subtotal(lines), 20);
});

test("order total applies tax", () => {
  assert.equal(orderTotal(createCustomer("Ada"), lines), 24);
});
`,

  "test/format.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { formatPrice } from "../src/index.js";

test("prices format as pounds", () => {
  assert.equal(formatPrice(3), "£3.00");
});
`,

  "README.md": `# orders

A small order pricing library: models, pricing, and formatting.
`,
};

function liveOnly(id: string): ScenarioTask["behavior"] {
  return {
    plan: {
      taskId: id,
      objective: "live-only",
      expectedFiles: [],
      expectedSymbols: [],
      dependencies: [],
      commands: [],
      externalAccess: [],
      riskLevel: "low",
    },
    async execute() {
      throw new Error(
        "The live-pricing scenario has no scripted behavior. Run it with " +
          "--live so a real agent performs the work.",
      );
    },
  };
}

function task(id: string, objective: string, agentId: string): ScenarioTask {
  return {
    task: { id, objective, agentId, validationCommands: VALIDATION_COMMANDS },
    behavior: liveOnly(id),
  };
}

/**
 * Three ordinary product requests. Two of them necessarily change how an order
 * total is computed, so they contend whether or not the agents realise it.
 */
export const LIVE_PRICING_SCENARIO: BenchmarkScenario = {
  name: "live-pricing",
  description:
    "Real agents on a structured module tree; overlap is discovered, not declared.",
  seed: SEED,
  tasks: [
    task(
      "task_handling_fee",
      "Add a flat handling fee of two pounds to what a customer pays for an order",
      "codex-a",
    ),
    task(
      "task_free_delivery",
      "Orders of one hundred pounds or more should not be charged delivery, and everything else should be charged three pounds",
      "codex-b",
    ),
    task(
      "task_rounding",
      "Round every amount a customer is shown to whole pence so totals never display long decimals",
      "codex-c",
    ),
  ],
};

/**
 * The forced-contention pair, phrased in checkout vocabulary.
 *
 * Both requests necessarily change how an order total is computed, so they
 * contend on `orderTotal` in `src/pricing/total.js` whatever the agents
 * declare. The wording is the experiment: "checkout", "order" and "total
 * price" invite plans that name a checkout or order module and a
 * calculate-style total function, none of which exist under those names. A
 * plan-time detector that only compares declared names against each other is
 * at the mercy of both agents inventing the *same* wrong name; this scenario
 * exists to measure exactly that, before and after grounding.
 */
export const LIVE_CHECKOUT_SCENARIO: BenchmarkScenario = {
  name: "live-checkout",
  description:
    "Two real-agent requests that must both change the order total; objectives use checkout vocabulary that matches no real file or symbol name.",
  seed: SEED,
  tasks: [
    task(
      "task_checkout_fee",
      "During checkout, add a flat two pound handling charge to every order's total price",
      "codex-a",
    ),
    task(
      "task_checkout_delivery",
      "During checkout, orders of one hundred pounds or more get free delivery and every other order is charged three pounds for delivery",
      "codex-b",
    ),
  ],
};

/**
 * The forced-contention pair plus a third contender, for replan-heavy runs.
 *
 * All three requests must change how an order total is computed or shown, so
 * a correct scheduler fully serialises them: the second task replans once and
 * the third twice, giving each run around three real replan round trips —
 * which is what an experiment about replan cost needs runs to contain.
 */
export const LIVE_CHECKOUT_TRIO_SCENARIO: BenchmarkScenario = {
  name: "live-checkout-trio",
  description:
    "Three real-agent requests that all touch the order total; objectives use checkout vocabulary that matches no real file or symbol name.",
  seed: SEED,
  tasks: [
    ...LIVE_CHECKOUT_SCENARIO.tasks,
    task(
      "task_checkout_rounding",
      "During checkout, round the order's total price to whole pence so customers never see long decimals",
      "codex-c",
    ),
  ],
};

/**
 * The same repository with six requests instead of three.
 *
 * Three tasks is enough to show that a real collision is found, and not enough
 * to say anything about how the advantage behaves as a team grows — which is
 * the claim the product actually rests on. Doubling the set is the smallest
 * change that tests it.
 *
 * Contention is deliberately layered rather than uniform: four of the six
 * change how a total is computed, two change how amounts are displayed, and
 * two change how discounts are decided, with overlap between those groups. A
 * scheduler that simply serialises everything and one that isolates genuinely
 * independent work should diverge here in a way they cannot at three.
 */
export const LIVE_PRICING_WIDE_SCENARIO: BenchmarkScenario = {
  name: "live-pricing-wide",
  description:
    "Six real-agent requests over one pricing library; contention is layered, not uniform.",
  seed: SEED,
  tasks: [
    ...LIVE_PRICING_SCENARIO.tasks,
    task(
      "task_card_surcharge",
      "Orders paid by card should cost an extra five percent on top of what the customer would otherwise pay",
      "codex-d",
    ),
    task(
      "task_loyalty_tier",
      "Customers who have placed more than twenty five orders should get fifteen percent off instead of ten",
      "codex-e",
    ),
    task(
      "task_savings_line",
      "When an order is summarised for a customer, show them how much they saved compared with the undiscounted price",
      "codex-f",
    ),
  ],
};
