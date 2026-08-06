import assert from "node:assert/strict";
import test from "node:test";

import type {
  DependencyEdge,
  IndexedFile,
  RepositoryIndex,
  SymbolCall,
} from "./index.js";
import {
  assessGroundedIntent,
  groundedIntentAssessor,
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
  symbolCalls: SymbolCall[] = [],
): IndexedFile {
  return {
    path: filePath,
    language: "javascript",
    bytes: 100,
    symbols,
    symbolRanges: [],
    symbolCalls,
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
      [
        { from: "orderTotal", to: "discountRate" },
        { from: "orderTotal", to: "taxFor" },
      ],
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
    indexedFile("src/format/money.js", ["formatMoney"]),
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

test("a call between the symbols two intents reach fires as calls, and scores lower", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Stop charging tax at the standard rate for digital goods", index),
    index,
  );
  assert.equal(result.fires, true);
  assert.equal(result.relation, "calls");
  assert.ok(result.score < DEFAULT_GROUNDED_INTENT_OPTIONS.sharedWeight);
  assert.deepEqual(result.callTargets, [
    "src/pricing/total.js#orderTotal -> src/pricing/tax.js#taxFor",
  ]);
});

test("an import without a call between the reached symbols is only adjacent", () => {
  // `money.js` is imported by the total but nothing in `orderTotal` calls
  // `formatMoney`, so the two files are neighbours and the two functions are
  // not. That distinction is the whole reason the call graph was added.
  const index = seedIndex({
    edges: [
      {
        fromFile: "src/pricing/total.js",
        toFile: "src/format/money.js",
        resource: "src/format/money.js",
        kind: "import",
      },
    ],
  });
  const result = assessGroundedIntent(
    paired("Add a flat handling charge to every order total for a customer", index),
    paired("Render money with a currency symbol for a customer", index),
    index,
  );
  assert.deepEqual(result.callTargets, []);
  assert.equal(result.relation, "adjacent");
  assert.deepEqual(result.adjacentTargets, [
    "src/pricing/total.js -> src/format/money.js",
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
  const linked = assessGroundedIntent(
    paired("Add a flat handling charge to every order total", index),
    paired("Stop charging tax at the standard rate for digital goods", index),
    index,
    options,
  );
  assert.equal(linked.relation, "calls");
  assert.equal(linked.fires, false);
});

test("a grounded target narrows to the symbols the intent names", () => {
  const index = seedIndex();
  const grounding = groundIntent(
    "Stop charging tax at the standard rate for digital goods",
    index,
  );
  assert.equal(grounding.targets[0]?.file, "src/pricing/tax.js");
  assert.deepEqual(grounding.targets[0]?.symbols, ["STANDARD_RATE", "taxFor"]);
});

test("the assessor produces advisory-shaped evidence and caches groundings", () => {
  const index = seedIndex();
  const assess = groundedIntentAssessor(index);
  const verdict = assess(
    { objective: "Add a flat handling charge to every order total" },
    { objective: "Add a card surcharge on top of the order total" },
  );
  assert.ok(verdict);
  assert.equal(verdict.probability, DEFAULT_GROUNDED_INTENT_OPTIONS.sharedWeight);
  assert.deepEqual(verdict.resources, ["src/pricing/total.js"]);
  // The audit trail has to carry the caveat, not just the doc.
  assert.match(verdict.explanation, /unvalidated/u);
});

test("the assessor prefers a plan's intent over its objective", () => {
  const index = seedIndex();
  const assess = groundedIntentAssessor(index);
  const silent = assess(
    {
      objective: "Add a flat handling charge to every order total",
      intent: "Rewrite the onboarding copy so it reads less formally",
    },
    { objective: "Add a card surcharge on top of the order total" },
  );
  assert.equal(silent, undefined);
});

test("the kill switch silences the assessor", () => {
  const index = seedIndex();
  const assess = groundedIntentAssessor(index);
  process.env["COORD_DISABLE_INTENT_GROUNDING"] = "1";
  try {
    assert.equal(
      assess(
        { objective: "Add a flat handling charge to every order total" },
        { objective: "Add a card surcharge on top of the order total" },
      ),
      undefined,
    );
  } finally {
    delete process.env["COORD_DISABLE_INTENT_GROUNDING"];
  }
});

test("both grounded with nothing between them is a positive finding, not silence", () => {
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Stop charging tax at the standard rate for digital goods", index),
    paired("Record the originating IP address on every audit entry", index),
    index,
  );
  assert.equal(result.fires, false);
  assert.equal(result.independent, true);
});

test("an ungrounded side is not a finding of independence", () => {
  // The difference that matters: "I checked and found nothing joining them"
  // versus "I could not tell what one of these tasks was about".
  const index = seedIndex();
  const result = assessGroundedIntent(
    paired("Stop charging tax at the standard rate for digital goods", index),
    paired("Rewrite the onboarding copy so it reads less formally", index),
    index,
  );
  assert.equal(result.fires, false);
  assert.equal(result.independent, false);
});

test("a vetoed pair is not reported as independent", () => {
  // Corroboration can stop a pair firing, but the repository still says the
  // two modules are connected. Reporting that as independence would invert it.
  const index = seedIndex();
  const left = paired("Add a flat handling charge to every order total", index);
  const right = paired(
    "Stop charging tax at the standard rate for digital goods",
    index,
  );
  const vetoed = assessGroundedIntent(left, right, index, {
    ...DEFAULT_GROUNDED_INTENT_OPTIONS,
    lexicon: undefined,
    fireThreshold: 2,
  });
  assert.equal(vetoed.fires, false);
  assert.equal(vetoed.independent, false);
  assert.deepEqual(vetoed.callTargets, [
    "src/pricing/total.js#orderTotal -> src/pricing/tax.js#taxFor",
  ]);
});

test("the assessor reports independence with both sides' modules and no score", () => {
  const index = seedIndex();
  const assess = groundedIntentAssessor(index);
  const verdict = assess(
    { objective: "Stop charging tax at the standard rate for digital goods" },
    { objective: "Record the originating IP address on every audit entry" },
  );
  assert.ok(verdict);
  assert.equal(verdict.independent, true);
  assert.equal(verdict.probability, 0);
  assert.deepEqual(verdict.resources, [
    "src/audit/log.js",
    "src/pricing/tax.js",
  ]);
});
