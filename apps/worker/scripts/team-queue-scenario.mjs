/**
 * A task queue shaped like a real team's, for the first realistic-scale
 * coordination measurement in this project.
 *
 * Every coordination experiment before this one used two to six tasks over two
 * or three agents, and the results were inconsistent for a reason that is a
 * property of the scenarios rather than of the coordinator: at that size a
 * scenario is either uniformly contended, in which case a correct scheduler
 * serialises everything and coordination has nothing to show beyond "it did
 * not corrupt anything", or it is uncontended, in which case no mechanism ever
 * fires. `live-checkout-trio` is the first shape and the grounding scenarios
 * are the second. Neither can answer whether coordinating a queue is worth
 * what it costs, because neither contains a queue.
 *
 * This one is built from the observation that a real backlog is mostly
 * independent work with a contended core. Ten tasks over five agents, in three
 * deliberately different bands:
 *
 * - **Deep conflict (3 tasks).** Every one of them must change how an order
 *   total is computed. They contend on `orderTotal` in `src/pricing/total.js`
 *   whatever they declare, and no ordering makes them independent — one of
 *   them lands and the other two are reasoning about a stale total.
 * - **Partial overlap (3 tasks).** Each owns a different pricing module that
 *   `total.js` imports. Two of them can run together; none of them can run
 *   together with a deep-conflict task that is rewriting the caller. This is
 *   the band that separates a scheduler which isolates genuinely independent
 *   work from one that serialises on any shared blast radius.
 * - **Independent (4 tasks).** Four unrelated feature areas — notifications,
 *   audit, export, search — with no imports into pricing and none between
 *   themselves. A correct scheduler runs all four concurrently with everything
 *   else. If coordination costs more than it saves, this is the band where the
 *   overhead shows up undisguised, because there is nothing here to protect.
 *
 * The objectives never name a file. That is the standing convention for live
 * scenarios in this repository and it matters here: the bands above are a
 * property of the repository, not of the wording, so the agents have to
 * discover the overlap the same way they would on real work. A scenario that
 * announced its own conflicts would measure the fixture.
 *
 * Five agent ids, two tasks each, one per band where the arithmetic allows, so
 * that no single agent owns a whole band and an agent-level scheduling effect
 * cannot be mistaken for a band-level one.
 */

const PACKAGE_JSON = `${JSON.stringify(
  { name: "accounts-service", private: true, type: "module" },
  undefined,
  2,
)}\n`;

/**
 * The contended core.
 *
 * `orderTotal` is the only place the three pricing inputs are combined, so any
 * change to what a customer pays has to pass through it. The three modules it
 * imports are separately ownable, which is what makes the partial-overlap band
 * possible: a task can own `discount.js` outright while still being visible to
 * anything rewriting the caller.
 */
const SEED = {
  "package.json": PACKAGE_JSON,

  "src/pricing/total.js": `import { discountRate } from "./discount.js";
import { taxFor } from "./tax.js";

const DELIVERY = 3;

/**
 * What a customer pays for an order.
 *
 * Everything that affects the amount is combined here: line items, the
 * customer's discount, delivery, and tax.
 */
export function orderTotal(order) {
  const lines = order.lines.reduce(
    (sum, line) => sum + line.price * line.quantity,
    0,
  );
  const discounted = lines * (1 - discountRate(order.customer));
  const withDelivery = discounted + DELIVERY;
  return withDelivery + taxFor(withDelivery, order);
}
`,

  "src/pricing/discount.js": `const LOYAL_ORDERS = 10;
const LOYAL_RATE = 0.1;

/** The proportion taken off a customer's line total. */
export function discountRate(customer) {
  if (customer === undefined) {
    return 0;
  }
  return customer.orders > LOYAL_ORDERS ? LOYAL_RATE : 0;
}
`,

  "src/pricing/tax.js": `const STANDARD_RATE = 0.2;

/** Tax charged on an amount for a given order. */
export function taxFor(amount, order) {
  void order;
  return amount * STANDARD_RATE;
}
`,

  "src/format/money.js": `/** Renders an amount as a customer-facing string. */
export function formatMoney(amount) {
  return \`£\${amount.toFixed(2)}\`;
}
`,

  // Four independent feature areas. Nothing here imports pricing, and nothing
  // here imports anything else here: a cross-import would become a plan
  // dependency and quietly move a task out of the independent band.
  "src/notify/webhook.js": `/** Delivers one event to a subscriber endpoint. */
export function deliver(subscriber, event, transport) {
  const response = transport(subscriber.url, event);
  return { url: subscriber.url, delivered: response.ok === true };
}
`,

  "src/notify/email.js": `const DEFAULT_CHANNEL = "email";

export function notificationChannel(account) {
  return account.channel ?? DEFAULT_CHANNEL;
}

export function send(account, message) {
  return { channel: notificationChannel(account), message };
}
`,

  "src/audit/log.js": `/** One entry in the audit trail. */
export function auditEntry(actor, action, subject) {
  return { actor, action, subject };
}

export function isPrivileged(action) {
  return action.startsWith("admin.");
}
`,

  "src/export/csv.js": `const COLUMNS = ["id", "name", "status"];

export function exportColumns() {
  return [...COLUMNS];
}

export function toCsv(rows) {
  const header = exportColumns().join(",");
  const body = rows.map((row) =>
    exportColumns()
      .map((key) => row[key] ?? "")
      .join(","),
  );
  return [header, ...body].join("\\n");
}
`,

  "src/search/accounts.js": `/** Substring search over account names. */
export function searchAccounts(accounts, query) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  return accounts.filter((account) =>
    account.name.toLowerCase().includes(needle),
  );
}
`,

  // One test file per source module, and this is load-bearing rather than
  // tidiness.
  //
  // The first live run of this scenario put all four independent features in
  // one `features.test.js` and all six pricing tasks in one
  // `pricing.test.js`. Every agent then — correctly — planned to update the
  // test file covering its change, so all four "independent" tasks declared
  // the same file and collided structurally with each other, as did all six
  // pricing tasks. The queue collapsed into two fully serialised chains, 92 of
  // 106 leases were deferred, and the run measured a fixture rather than a
  // coordinator. Shared test files serialise real teams the same way, which
  // makes it a true observation about repositories and a useless one here: a
  // scenario whose bands are defined by the source tree has to carry that
  // separation all the way through its tests, or the bands do not exist.
  //
  // Tests assert only what no task should break — that a total is positive,
  // that loyal customers are discounted at all — never an exact figure, which
  // the first task to land would invalidate.
  "test/total.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { orderTotal } from "../src/pricing/total.js";

const order = (extra = {}) => ({
  lines: [{ price: 20, quantity: 2 }],
  customer: { orders: 3 },
  ...extra,
});

test("an order total is a positive number", () => {
  const total = orderTotal(order());
  assert.equal(Number.isFinite(total), true);
  assert.equal(total > 0, true);
});

test("a bigger basket costs more than a smaller one", () => {
  const small = orderTotal(order({ lines: [{ price: 10, quantity: 1 }] }));
  const large = orderTotal(order({ lines: [{ price: 10, quantity: 5 }] }));
  assert.equal(large > small, true);
});
`,

  "test/discount.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { discountRate } from "../src/pricing/discount.js";

test("loyal customers are discounted and new ones are not", () => {
  assert.equal(discountRate({ orders: 50 }) > 0, true);
  assert.equal(discountRate({ orders: 1 }), 0);
  assert.equal(discountRate(undefined), 0);
});
`,

  "test/tax.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { taxFor } from "../src/pricing/tax.js";

test("tax is charged on a standard order", () => {
  const order = { lines: [{ price: 20, quantity: 2 }] };
  assert.equal(taxFor(100, order) > 0, true);
});
`,

  "test/money.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { formatMoney } from "../src/format/money.js";

test("money renders with a currency symbol", () => {
  assert.match(formatMoney(12.5), /£/u);
});
`,

  "test/webhook.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { deliver } from "../src/notify/webhook.js";

test("webhook delivery reports the endpoint it used", () => {
  const result = deliver({ url: "https://example.test/hook" }, { id: 1 }, () => ({
    ok: true,
  }));
  assert.equal(result.url, "https://example.test/hook");
  assert.equal(result.delivered, true);
});
`,

  "test/email.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { send } from "../src/notify/email.js";

test("notifications use the account channel", () => {
  assert.equal(send({ channel: "sms" }, "hi").channel, "sms");
});
`,

  "test/audit.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { auditEntry, isPrivileged } from "../src/audit/log.js";

test("audit records the actor and marks privileged actions", () => {
  assert.equal(auditEntry("ada", "read", "acct").actor, "ada");
  assert.equal(isPrivileged("admin.delete"), true);
  assert.equal(isPrivileged("read"), false);
});
`,

  "test/export.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { exportColumns, toCsv } from "../src/export/csv.js";

test("exports keep id, name and status columns", () => {
  for (const column of ["id", "name", "status"]) {
    assert.equal(exportColumns().includes(column), true);
  }
  assert.match(toCsv([{ id: 1, name: "x", status: "ok" }]), /^id,name,status/u);
});
`,

  "test/search.test.js": `import assert from "node:assert/strict";
import test from "node:test";

import { searchAccounts } from "../src/search/accounts.js";

test("search matches on name and rejects empty queries", () => {
  const accounts = [{ name: "Ada", email: "ada@example.test" }];
  assert.deepEqual(searchAccounts(accounts, "  "), []);
  assert.equal(searchAccounts(accounts, "ad").length, 1);
});
`,

  "README.md": `# accounts-service

Pricing (\`src/pricing\`) combines line items, discounts, delivery and tax into
an order total. Four further feature areas — notifications, audit, export and
search — are independent of pricing and of each other.

Each module has its own test file under \`test/\`, named after the module. Keep
it that way: a change to one module should not require touching another
module's tests.
`,
};

const VALIDATION_COMMANDS = [
  { executable: "node", args: ["--test"], label: "repository tests" },
];

function task(id, objective, agentId, band) {
  return {
    band,
    task: { id, objective, agentId, validationCommands: VALIDATION_COMMANDS },
    behavior: {
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
        throw new Error("team-queue has no scripted behaviour; run it live");
      },
    },
  };
}

export const TEAM_QUEUE_SCENARIO = {
  name: "team-queue",
  description:
    "Ten requests over five agents against one service: three that must all " +
    "rewrite the order total, three that each own one module the total " +
    "imports, and four unrelated feature areas.",
  seed: SEED,
  tasks: [
    // Deep conflict: all three necessarily change how a total is computed.
    task(
      "task_handling_fee",
      "Add a flat two pound handling charge to every order's total",
      "codex-a",
      "deep",
    ),
    task(
      "task_free_delivery",
      "Orders of one hundred pounds or more should not be charged for delivery, and every other order should be charged three pounds",
      "codex-b",
      "deep",
    ),
    task(
      "task_card_surcharge",
      "Orders paid by card should cost an extra five percent on top of what the customer would otherwise pay",
      "codex-c",
      "deep",
    ),

    // Partial overlap: one owned module each, all of them read by the total.
    task(
      "task_loyalty_tier",
      "Customers who have placed more than twenty five orders should get fifteen percent off instead of ten",
      "codex-d",
      "partial",
    ),
    task(
      "task_zero_rated_goods",
      "Orders that contain only digital goods should not be charged tax",
      "codex-e",
      "partial",
    ),
    task(
      "task_rounding",
      "Round every amount a customer is shown to whole pence so totals never display long decimals",
      "codex-a",
      "partial",
    ),

    // Independent: four unrelated feature areas.
    task(
      "task_webhook_retry",
      "Retry webhook delivery up to three times when the transport reports a failure",
      "codex-b",
      "independent",
    ),
    task(
      "task_audit_ip",
      "Record the originating IP address on every audit entry",
      "codex-c",
      "independent",
    ),
    task(
      "task_export_created_at",
      "Add a created-at column to the CSV export",
      "codex-d",
      "independent",
    ),
    task(
      "task_search_email",
      "Make account search match on email address as well as name",
      "codex-e",
      "independent",
    ),
  ],
};

/** The band a task was designed into, for reporting results by band. */
export const TEAM_QUEUE_BANDS = Object.fromEntries(
  TEAM_QUEUE_SCENARIO.tasks.map((entry) => [entry.task.id, entry.band]),
);

/**
 * Pairs that genuinely cannot both land unexamined, by construction.
 *
 * This is the scenario's own claim about itself, written down before any run,
 * and it is what the measured conflict decisions are scored against. Every
 * deep-band pair is here because all three rewrite `orderTotal`. Deep-partial
 * pairs are here because a partial-band task changes a function the deep task
 * is rewriting the caller of. Nothing else is: two partial-band tasks own
 * different modules, and the independent band shares nothing with anything.
 */
export const TEAM_QUEUE_TRUE_CONFLICTS = (() => {
  const band = TEAM_QUEUE_BANDS;
  const ids = Object.keys(band);
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = band[ids[i]];
      const right = band[ids[j]];
      const bothDeep = left === "deep" && right === "deep";
      const deepAndPartial =
        (left === "deep" && right === "partial") ||
        (left === "partial" && right === "deep");
      if (bothDeep || deepAndPartial) {
        pairs.push([ids[i], ids[j]].sort().join("|"));
      }
    }
  }
  return new Set(pairs);
})();
