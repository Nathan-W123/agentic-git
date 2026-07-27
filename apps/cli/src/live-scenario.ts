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
