import assert from "node:assert/strict";
import test from "node:test";

import type { IndexedFile, RepositoryIndex } from "@coord/code-intelligence";

import {
  estimateScope,
  likelySymbolsIn,
  moduleRootFor,
  moduleRootsFrom,
} from "./scope-estimation.js";

/**
 * Guessing a task's footprint from its objective, before any agent exists.
 *
 * The estimate is only ever allowed to be a hint, so these tests care as much
 * about what it refuses to claim — an objective that matches nothing, a word
 * that matches everything — as about what it finds.
 */

function file(
  filePath: string,
  overrides: Partial<IndexedFile> = {},
): IndexedFile {
  return {
    path: filePath,
    language: "typescript",
    bytes: 100,
    symbols: [],
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
    ...overrides,
  };
}

function repositoryIndex(
  files: IndexedFile[],
  extraPaths: string[] = [],
  overrides: Partial<RepositoryIndex> = {},
): RepositoryIndex {
  return {
    repositoryId: "example",
    revision: "a".repeat(40),
    generatedAt: "2026-01-01T00:00:00.000Z",
    files,
    edges: [],
    paths: [...files.map((entry) => entry.path), ...extraPaths].sort(),
    truncated: false,
    skippedFiles: 0,
    ...overrides,
  };
}

/** Two independent packages plus an app, each with its own manifest. */
function workspaceIndex(): RepositoryIndex {
  return repositoryIndex(
    [
      file("services/billing/src/invoice.ts", {
        symbols: ["createInvoice", "InvoiceLine"],
      }),
      file("services/billing/src/tax.ts", { symbols: ["taxRate"] }),
      file("services/billing/src/ledger.ts", { symbols: ["postLedgerEntry"] }),
      file("services/notifications/src/email.ts", {
        symbols: ["sendEmail", "EmailTemplate"],
      }),
      file("services/notifications/src/sms.ts", { symbols: ["sendSms"] }),
      file("services/notifications/src/queue.ts", {
        symbols: ["enqueueDelivery"],
      }),
      file("apps/dashboard/src/screen.ts", { symbols: ["renderScreen"] }),
    ],
    [
      "services/billing/package.json",
      "services/notifications/package.json",
      "apps/dashboard/package.json",
      "README.md",
    ],
  );
}

test("module roots come from the repository's own manifests", () => {
  const roots = moduleRootsFrom(workspaceIndex());
  assert.deepEqual(roots.slice().sort(), [
    "apps/dashboard",
    "services/billing",
    "services/notifications",
  ]);
  assert.equal(
    moduleRootFor("services/billing/src/tax.ts", roots),
    "services/billing",
  );
  assert.equal(moduleRootFor("README.md", roots), "");
});

test("a repository with no manifests falls back to top-level directories", () => {
  const index = repositoryIndex([
    file("src/one.ts"),
    file("docs/two.ts"),
  ]);
  assert.deepEqual(moduleRootsFrom(index).slice().sort(), ["docs", "src"]);
});

test("an objective naming a real file anchors on it", () => {
  const estimate = estimateScope(
    "Correct the rounding in services/billing/src/tax.ts",
    workspaceIndex(),
  );
  assert.equal(estimate.confidence, "anchored");
  assert.deepEqual(estimate.namedPaths, ["services/billing/src/tax.ts"]);
  assert.equal(estimate.files[0]?.path, "services/billing/src/tax.ts");
  assert.ok(estimate.files[0]?.anchored);
});

test("sentence punctuation does not hide a named path", () => {
  const estimate = estimateScope(
    "The rounding is wrong in services/billing/src/tax.ts.",
    workspaceIndex(),
  );
  assert.deepEqual(estimate.namedPaths, ["services/billing/src/tax.ts"]);
});

test("an objective naming a directory pulls in what is under it", () => {
  const estimate = estimateScope(
    "Harden everything under services/notifications",
    workspaceIndex(),
  );
  assert.deepEqual(estimate.namedDirectories, ["services/notifications"]);
  const selected = estimate.files.map((entry) => entry.path);
  assert.ok(selected.includes("services/notifications/src/email.ts"));
  assert.ok(selected.includes("services/notifications/src/queue.ts"));
  assert.ok(!selected.includes("apps/dashboard/src/screen.ts"));
});

test("symbol and directory words localize an objective across two modules", () => {
  const estimate = estimateScope(
    "Give invoices a currency field and give the delivery queue a receipt",
    workspaceIndex(),
  );
  assert.equal(estimate.confidence, "anchored");
  const roots = estimate.modules.map((entry) => entry.root).sort();
  assert.deepEqual(roots, ["services/billing", "services/notifications"]);
  assert.ok(
    estimate.files.some(
      (entry) => entry.path === "services/billing/src/invoice.ts",
    ),
  );
  assert.ok(
    estimate.files.some(
      (entry) => entry.path === "services/notifications/src/queue.ts",
    ),
  );
});

test("an objective the repository does not recognize estimates nothing", () => {
  const estimate = estimateScope(
    "Investigate why the nightly pipeline is flaky",
    workspaceIndex(),
  );
  assert.equal(estimate.confidence, "none");
  assert.deepEqual(estimate.files, []);
  assert.ok(estimate.notes.some((note) => note.includes("footprint is unknown")));
});

test("a word matching most of the repository is discarded, not believed", () => {
  const files = Array.from({ length: 30 }, (_entry, order) =>
    file(`src/module${order}.ts`, { symbols: [`widgetPart${order}`] }),
  );
  const estimate = estimateScope(
    "Improve widget rendering",
    repositoryIndex(files),
  );
  assert.equal(estimate.confidence, "none");
  assert.ok(
    estimate.notes.some((note) => note.includes("too common to localize")),
  );
});

test("a word matching a minority of files still localizes", () => {
  const files = [
    ...Array.from({ length: 27 }, (_entry, order) =>
      file(`src/module${order}.ts`, { symbols: [`unrelatedPart${order}`] }),
    ),
    file("src/widget-a.ts", { symbols: ["widgetAlpha"] }),
    file("src/widget-b.ts", { symbols: ["widgetBeta"] }),
  ];
  const estimate = estimateScope(
    "Improve widget rendering",
    repositoryIndex(files),
  );
  assert.equal(estimate.confidence, "anchored");
  assert.deepEqual(
    estimate.files.map((entry) => entry.path).sort(),
    ["src/widget-a.ts", "src/widget-b.ts"],
  );
});

test("a file matched only through its own basename is not anchored", () => {
  const index = repositoryIndex([
    file("src/telemetry.ts", { symbols: ["startup"] }),
  ]);
  const estimate = estimateScope("Reduce telemetry volume", index);
  assert.equal(estimate.confidence, "weak");
  assert.equal(estimate.files.length, 1);
  assert.equal(estimate.files[0]?.anchored, false);
});

test("a truncated index is reported as a lower bound", () => {
  const index = repositoryIndex(
    [file("services/billing/src/invoice.ts", { symbols: ["createInvoice"] })],
    ["services/billing/package.json"],
    { truncated: true, skippedFiles: 12 },
  );
  const estimate = estimateScope("Adjust invoice totals", index);
  assert.ok(estimate.indexTruncated);
  assert.ok(estimate.notes.some((note) => note.includes("lower bound")));
});

test("generic engineering words alone select nothing", () => {
  const estimate = estimateScope(
    "Please update the service handler and add tests",
    workspaceIndex(),
  );
  assert.equal(estimate.confidence, "none");
  assert.deepEqual(estimate.tokens, []);
});

test("the estimate is capped and reports the cap", () => {
  const files = Array.from({ length: 12 }, (_entry, order) =>
    file(`services/billing/src/part${order}.ts`, {
      symbols: [`invoicePart${order}`],
    }),
  );
  const estimate = estimateScope(
    "Adjust invoice handling",
    repositoryIndex(files, ["services/billing/package.json"]),
    // The ubiquity filter is off here on purpose: "invoice" naming all twelve
    // files is precisely what that filter exists to reject, and this test is
    // about the cap that applies once a token has been believed.
    { maxFiles: 5, ubiquityRatio: 1 },
  );
  assert.equal(estimate.files.length, 5);
  assert.ok(estimate.notes.some((note) => note.includes("kept the 5 strongest")));
});

/**
 * Reading an objective for the declarations it is about.
 *
 * Names are taken from a real file two agents actually collided on, because
 * the cases that matter are the ones real names produce: a house prefix
 * nobody writes in prose, and a pair of declarations that share every word
 * they have.
 */
const CHANNEL_DECLARATIONS = [
  { name: "chanHeader" },
  { name: "chanSidebar" },
  { name: "agentHistory" },
  { name: "agentHistoryRows" },
  { name: "pinnedBanner" },
  { name: "threadPanel" },
  { name: "threadReplyChip" },
  { name: "threadListPanel" },
  { name: "renderChats" },
];

test("an objective claims the declarations it is about, prefix and all", () => {
  // "chan" is a house prefix and will never appear in prose. Requiring every
  // fragment of the name would find nothing here, which is the whole file.
  assert.deepEqual(
    likelySymbolsIn(
      "remove the header's notification bell and its unused spacing",
      CHANNEL_DECLARATIONS,
    ),
    ["chanHeader"],
  );
});

test("two declarations that are the same piece of work are both claimed", () => {
  // `agentHistory` and `agentHistoryRows` share every word. Requiring a
  // fragment unique to one would claim neither, and they are one job.
  assert.deepEqual(
    likelySymbolsIn(
      "agent history looks really bloated, make it clean",
      CHANNEL_DECLARATIONS,
    ),
    ["agentHistory", "agentHistoryRows"],
  );
});

test("an objective about nothing in the file claims nothing", () => {
  // The safe answer, and the one that was already being given: no claim here
  // means the caller keeps the whole file, exactly as before.
  assert.deepEqual(likelySymbolsIn("make the app better", CHANNEL_DECLARATIONS), []);
  assert.deepEqual(likelySymbolsIn("", CHANNEL_DECLARATIONS), []);
  assert.deepEqual(likelySymbolsIn("fix the header", []), []);
});

test("a word most of the file shares is evidence about nothing", () => {
  // "thread" is in three of these and would drag all of them in. A fragment
  // stops being evidence once it stops pointing at a small part of the file.
  const wide = Array.from({ length: 40 }, (_, index) => ({
    name: `threadThing${String(index)}`,
  }));
  assert.deepEqual(likelySymbolsIn("rework the thread rendering", wide), []);
});

test("a name written out in full is claimed however common its words are", () => {
  assert.deepEqual(
    likelySymbolsIn("renderChats is doing too much", CHANNEL_DECLARATIONS),
    ["renderChats"],
  );
});
