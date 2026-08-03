import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPlan } from "@coord/shared-types";

import type { IndexedFile, RepositoryIndex } from "./index.js";
import { groundPlan, identifierTokens } from "./plan-grounding.js";

/**
 * Grounding is judged against a fixed index modelled on the live-pricing
 * benchmark repository — the same shape the real hallucinations were recorded
 * against: a pricing module whose total lives in `src/pricing/total.js` under
 * the name `orderTotal`, with no checkout file anywhere.
 */

function indexedFile(
  filePath: string,
  symbols: string[],
): IndexedFile {
  return {
    path: filePath,
    language: "javascript",
    bytes: 100,
    symbols,
    symbolRanges: [],
    symbolCalls: [],
    imports: [],
    dependencies: [],
    referencedSymbols: [],
    apis: [],
    schemas: [],
    configKeys: [],
    tests: [],
    services: [],
  };
}

function pricingIndex(overrides: Partial<RepositoryIndex> = {}): RepositoryIndex {
  const files = [
    indexedFile("src/pricing/total.js", ["subtotal", "orderTotal"]),
    indexedFile("src/pricing/tax.js", ["TAX_RATE", "taxFor"]),
    indexedFile("src/pricing/discount.js", ["discountRate", "applyDiscount"]),
    indexedFile("src/models/order.js", ["createOrder"]),
    indexedFile("src/models/customer.js", ["createCustomer"]),
    indexedFile("src/format/currency.js", ["formatPrice"]),
  ];
  return {
    repositoryId: "repo_orders",
    revision: "a".repeat(40),
    generatedAt: new Date().toISOString(),
    files,
    edges: [],
    paths: [...files.map((file) => file.path), "package.json", "README.md"],
    truncated: false,
    skippedFiles: 0,
    ...overrides,
  };
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    taskId: "task_a",
    objective: "objective",
    expectedFiles: [],
    expectedSymbols: [],
    dependencies: [],
    commands: [],
    externalAccess: [],
    riskLevel: "low",
    ...overrides,
  };
}

test("a plan naming only real files and symbols is verified untouched", () => {
  const grounded = groundPlan(
    plan({
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: ["orderTotal"],
    }),
    pricingIndex(),
  );

  assert.equal(grounded.grounding?.confidence, "verified");
  assert.deepEqual(grounded.grounding?.missingFiles, []);
  assert.deepEqual(grounded.grounding?.unresolvedSymbols, []);
  assert.deepEqual(grounded.grounding?.fileReferents, []);
  assert.deepEqual(grounded.grounding?.symbolReferents, []);
});

test("a README is real even though the indexer never parsed it", () => {
  const grounded = groundPlan(
    plan({ expectedFiles: ["README.md"] }),
    pricingIndex(),
  );

  assert.equal(grounded.grounding?.confidence, "verified");
});

test("a missing path grounds to the real file with the same basename", () => {
  const grounded = groundPlan(
    plan({ expectedFiles: ["src/order.js"] }),
    pricingIndex(),
  );

  assert.equal(grounded.grounding?.confidence, "grounded");
  assert.deepEqual(grounded.grounding?.missingFiles, ["src/order.js"]);
  assert.deepEqual(grounded.grounding?.fileReferents, [
    { declared: "src/order.js", resolved: "src/models/order.js" },
  ]);
});

test("a hallucinated symbol grounds to its real counterpart and that file", () => {
  const grounded = groundPlan(
    plan({
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: ["calculateTotal"],
    }),
    pricingIndex(),
  );

  assert.equal(grounded.grounding?.confidence, "grounded");
  assert.deepEqual(grounded.grounding?.unresolvedSymbols, ["calculateTotal"]);
  assert.deepEqual(grounded.grounding?.symbolReferents, [
    {
      declared: "calculateTotal",
      resolved: "orderTotal",
      files: ["src/pricing/total.js"],
    },
  ]);
});

test("a symbol made only of generic verbs grounds to nothing", () => {
  const grounded = groundPlan(
    plan({
      expectedFiles: ["src/pricing/total.js"],
      expectedSymbols: ["runUpdate"],
    }),
    pricingIndex(),
  );

  // The declared file anchors the plan; the vague symbol is treated as new
  // rather than being mapped onto half the repository.
  assert.equal(grounded.grounding?.confidence, "grounded");
  assert.deepEqual(grounded.grounding?.symbolReferents, []);
});

test("a plan naming nothing that exists or resolves is ungrounded", () => {
  const grounded = groundPlan(
    plan({
      expectedFiles: ["src/checkout.js"],
      expectedSymbols: ["processPayment"],
    }),
    pricingIndex(),
  );

  assert.equal(grounded.grounding?.confidence, "ungrounded");
  assert.deepEqual(grounded.grounding?.fileReferents, []);
  assert.deepEqual(grounded.grounding?.symbolReferents, []);
});

test("a truncated index never condemns a plan as ungrounded", () => {
  const grounded = groundPlan(
    plan({
      expectedFiles: ["src/checkout.js"],
      expectedSymbols: ["processPayment"],
    }),
    pricingIndex({ truncated: true, skippedFiles: 3 }),
  );

  assert.equal(grounded.grounding?.confidence, "grounded");
});

test("grounding a plan overwrites whatever grounding it arrived with", () => {
  const forged: AgentPlan = {
    ...plan({ expectedFiles: ["src/checkout.js"] }),
    grounding: {
      confidence: "verified",
      revision: "b".repeat(40),
      missingFiles: [],
      unresolvedSymbols: [],
      fileReferents: [],
      symbolReferents: [],
      notes: [],
    },
  };
  const grounded = groundPlan(forged, pricingIndex());

  assert.equal(grounded.grounding?.confidence, "ungrounded");
  assert.equal(grounded.grounding?.revision, "a".repeat(40));
});

test("identifier tokens split camelCase, snake_case and acronyms", () => {
  assert.deepEqual(identifierTokens("calculateTotal"), ["calculate", "total"]);
  assert.deepEqual(identifierTokens("TAX_RATE"), ["tax", "rate"]);
  assert.deepEqual(identifierTokens("HTTPServer2"), ["http", "server", "2"]);
});
