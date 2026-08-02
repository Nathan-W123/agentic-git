import assert from "node:assert/strict";
import test from "node:test";

import type { DependencyEdge, IndexedFile, RepositoryIndex } from "./index.js";
import {
  assessGroundedIntent,
  groundIntent,
  DEFAULT_GROUNDED_INTENT_OPTIONS,
} from "./intent-grounding.js";

/**
 * Judged against an index modelled on the team-queue scenario's seed: a
 * pricing total that imports a discount module and a tax module, plus
 * unrelated feature areas. That shape is what makes the interesting cases
 * possible — two tasks on the same file, two tasks on files linked by an
 * import, and two tasks on files with nothing between them.
 */

function indexedFile(
  filePath: string,
  symbols: string[],
  imports: string[] = [],
): IndexedFile {
  return {
    path: filePath,
    language: "javascript",
    bytes: 100,
    symbols,
    symbolRanges: [],
    imports,
    dependencies: imports,
    referencedSymbols: [],
    apis: [],
    schemas: [],
    configKeys: [],
    tests: [],
    services: [],
  };
}

function seedIndex(overrides: Partial<RepositoryIndex> = {}): RepositoryIndex {
  const files = [
    indexedFile(
      "src/pricing/total.js",
      ["DELIVERY", "orderTotal", "lines", "discounted", "withDelivery"],
      ["./discount.js", "./tax.js"],
    ),
    indexedFile("src/pricing/discount.js", [
      "LOYAL_ORDERS",
      "LOYAL_RATE",
      "discountRate",
    ]),
    indexedFile("src/pricing/tax.js", ["STANDARD_RATE", "taxFor"]),
    indexedFile("src/notify/webhook.js", ["deliver"]),
    indexedFile("src/audit/log.js", ["auditEntry", "isPrivileged"]),
    indexedFile("src/search/accounts.js", ["searchAccounts"]),
    // A test file shadows its module's vocabulary and must never be a target.
    indexedFile("test/total.test.js", ["order"]),
  ];
  const edges: DependencyEdge[] = [
    {
      fromFile: "src/pricing/total.js",
      toFile: "src/pricing/discount.js",
      resource: "src/pricing/discount.js",
      kind: "import",
    },
    {
      fromFile: "src/pricing/total.js",
      toFile: "src/pricing/tax.js",
      resource: "src/pricing/tax.js",
      kind: "import",
    },
  ];
  return {
    repositoryId: "repo_seed",
    revision: "main",
    generatedAt: new Date(0).toISOString(),
    files,
    edges,
    paths: files.map((file) => file.path),
    truncated: false,
    skippedFiles: 0,
    ...overrides,
  };
}

const paired = (text: string, index: RepositoryIndex) => ({
  text,
  grounding: groundIntent(text, index),
});

test("an intent grounds to the module its words name", () => {
  const index = seedIndex();
  const grounding = groundIntent(
    "Add a five-percent surcharge to the final order total when paid by card",
    index,
  );
  assert.equal(grounding.confidence, "grounded");
  assert.equal(grounding.targets[0]?.file, "src/pricing/total.js");
});

test("test files are never grounding targets", () => {
  const index = seedIndex();
  const grounding = groundIntent("Change how an order total is computed", index);
  assert.equal(
    grounding.targets.some((target) => target.file.startsWith("test/")),
    false,
  );
});

test("an intent sharing no vocabulary with the repository grounds nowhere", () => {
  const index = seedIndex();
  const grounding = groundIntent(
    "Rewrite the onboarding copy so it reads less formally",
    index,
  );
  assert.deepEqual(grounding.targets, []);
  assert.equal(grounding.confidence, "ungrounded");
  assert.match(grounding.notes.join(" "), /no opinion/u);
});

test("a homonym does not carry an intent into an unrelated module", () => {
  // "delivery" is a real anchor of the pricing total, which declares
  // `const DELIVERY`. A webhook task saying "delivery API" must not reach it.
  const index = seedIndex();
  const grounding = groundIntent(
    "Retry webhook delivery up to three times when the transport fails",
    index,
  );
  assert.equal(
    grounding.targets.some((target) => target.file === "src/pricing/total.js"),
    false,
  );
});

test("two intents on the same module fire as a shared target", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Add a card surcharge on top of the order total", index),
    index,
  );
  assert.equal(result.fires, true);
  assert.equal(result.relation, "shared");
  assert.deepEqual(result.sharedTargets, ["src/pricing/total.js"]);
});

test("two intents on modules linked by an import fire as adjacent, and score lower", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Stop charging tax at the standard rate for digital goods", index),
    index,
  );
  assert.equal(result.fires, true);
  assert.equal(result.relation, "adjacent");
  assert.ok(result.score < DEFAULT_GROUNDED_INTENT_OPTIONS.sharedWeight);
  assert.deepEqual(result.adjacentTargets, [
    "src/pricing/total.js -> src/pricing/tax.js",
  ]);
});

test("two intents on modules with no edge between them stay silent", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Stop charging tax at the standard rate for digital goods", index),
    paired("Record the originating IP address on every audit entry", index),
    index,
  );
  assert.equal(result.fires, false);
  assert.equal(result.relation, undefined);
});

test("a caller answers to the vocabulary of the locals in its body", () => {
  // `orderTotal` computes `const discounted = ...`, so the index records
  // "discount" as a name `src/pricing/total.js` declares and a discount intent
  // reaches the caller directly rather than through the import edge. This is
  // the index's own model of what a file declares — the same `file.symbols`
  // plan grounding resolves declarations against — and it is asserted here
  // because it changes which *relation* a pair gets, not merely a score:
  // caller and callee come out as one shared target instead of two adjacent
  // ones. Separating a module's public vocabulary from its function bodies is
  // a change to the indexer, not to this signal, and is not made here.
  const index = seedIndex();
  const grounding = groundIntent(
    "Give customers with more than twenty five orders a bigger loyalty discount rate",
    index,
  );
  assert.deepEqual(
    grounding.targets.map((target) => target.file),
    ["src/pricing/discount.js", "src/pricing/total.js"],
  );
  assert.deepEqual(grounding.targets[1]?.anchors, ["discount", "order"]);
});

test("an ungrounded side cannot fire however similar the sentences are", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Add a flat handling charge to every invoice subtotal", {
      ...seedIndex(),
      files: [],
      edges: [],
    }),
    index,
  );
  assert.equal(result.fires, false);
});

test("grounding overlap without a shared intent term does not fire", () => {
  // Corroboration is a veto, not evidence: the audit trail has to be able to
  // name a word the two sentences agree on.
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Rewrite the onboarding copy so it reads less formally", index),
    index,
  );
  assert.equal(result.fires, false);
  assert.deepEqual(result.corroboration, []);
});

test("opposition raises the score but is not required to fire", () => {
  const index = seedIndex();
  const plain = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Add a card surcharge on top of the order total", index),
    index,
  );
  assert.equal(plain.fires, true);
  assert.equal(plain.opposition, undefined);
  assert.equal(plain.score, DEFAULT_GROUNDED_INTENT_OPTIONS.sharedWeight);
});

test("a raised fire threshold reduces the signal to shared targets only", () => {
  const index = seedIndex();
  const options = {
    ...DEFAULT_GROUNDED_INTENT_OPTIONS,
    fireThreshold: DEFAULT_GROUNDED_INTENT_OPTIONS.sharedWeight,
  };
  const adjacent = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Stop charging tax at the standard rate for digital goods", index),
    index,
    options,
  );
  assert.equal(adjacent.relation, "adjacent");
  assert.equal(adjacent.fires, false);
});
