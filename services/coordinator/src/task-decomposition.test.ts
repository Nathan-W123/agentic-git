import assert from "node:assert/strict";
import test from "node:test";

import type {
  DependencyEdge,
  IndexedFile,
  RepositoryIndex,
} from "@coord/code-intelligence";

import { estimateScope, type ScopeEstimate } from "./scope-estimation.js";
import {
  atomicSignals,
  couplePieces,
  decomposeTask,
  parseDecompositionMode,
  type ContendingWork,
  type DecompositionOptions,
} from "./task-decomposition.js";

/**
 * The intake-time decision to split one objective into several tasks.
 *
 * Almost every test here asserts a refusal, which is the point: the feature is
 * a series of reasons not to split, and each of those reasons is a way a split
 * could have damaged a task that had to stay whole.
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

/**
 * Two independent services and a dashboard, each a workspace of its own.
 *
 * Nothing here imports anything there: the fixture is the shape a split is
 * supposed to be legal on, and individual tests add the coupling that should
 * make it illegal.
 */
function workspaceIndex(edges: DependencyEdge[] = []): RepositoryIndex {
  return {
    repositoryId: "example",
    revision: "b".repeat(40),
    generatedAt: "2026-01-01T00:00:00.000Z",
    files: [
      file("services/billing/src/invoice.ts", {
        symbols: ["createInvoice", "InvoiceLine"],
      }),
      file("services/billing/src/tax.ts", { symbols: ["invoiceTaxRate"] }),
      file("services/notifications/src/receipt.ts", {
        symbols: ["deliveryReceipt"],
      }),
      file("services/notifications/src/queue.ts", {
        symbols: ["deliveryQueue"],
      }),
      file("apps/dashboard/src/screen.ts", { symbols: ["renderScreen"] }),
    ],
    edges,
    paths: [
      "apps/dashboard/package.json",
      "apps/dashboard/src/screen.ts",
      "services/billing/package.json",
      "services/billing/src/invoice.ts",
      "services/billing/src/tax.ts",
      "services/notifications/package.json",
      "services/notifications/src/queue.ts",
      "services/notifications/src/receipt.ts",
    ],
    truncated: false,
    skippedFiles: 0,
  };
}

/** An objective that lands squarely in billing and notifications, nowhere else. */
const SPANNING_OBJECTIVE =
  "Give invoices a currency column and give delivery receipts a timestamp";

function decide(
  objective: string,
  index: RepositoryIndex,
  contention: ContendingWork[] = [],
  options: DecompositionOptions = { mode: "always" },
) {
  return decomposeTask({
    objective,
    estimate: estimateScope(objective, index),
    index,
    contention,
    options,
  });
}

test("the fixture objective really does span two modules", () => {
  const estimate = estimateScope(SPANNING_OBJECTIVE, workspaceIndex());
  assert.equal(estimate.confidence, "anchored");
  assert.deepEqual(
    estimate.modules.map((entry) => entry.root).sort(),
    ["services/billing", "services/notifications"],
  );
  assert.ok(estimate.files.length >= 4);
});

test("independent modules are split, one task each", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex());
  assert.equal(decision.reason, "split");
  assert.equal(decision.split, true);
  assert.equal(decision.subtasks.length, 2);
  assert.deepEqual(
    decision.subtasks.flatMap((subtask) => subtask.modules).sort(),
    ["services/billing", "services/notifications"],
  );
  // The pieces must not overlap: that is the entire point of the exercise.
  const [first, second] = decision.subtasks;
  assert.ok(first && second);
  assert.equal(
    first.files.filter((entry) => second.files.includes(entry)).length,
    0,
  );
});

test("each piece carries the original objective plus its own scope", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex());
  for (const subtask of decision.subtasks) {
    assert.ok(subtask.objective.startsWith(SPANNING_OBJECTIVE));
    assert.ok(subtask.objective.includes("Scope constraint"));
    assert.ok(subtask.objective.includes(subtask.modules[0] ?? "?"));
    assert.ok(subtask.objective.includes("Sibling tasks cover"));
    assert.ok(subtask.objective.includes("request a scope change"));
    for (const filePath of subtask.files) {
      assert.ok(subtask.objective.includes(filePath));
    }
  }
});

test("an objective that reads as one indivisible change is never split", () => {
  for (const wording of [
    "Rename invoices to bills and rename delivery receipts to acknowledgements",
    "Refactor invoices and delivery receipts to share a base",
    "Move invoice and delivery receipt types together into one place",
    "Bump the invoice and delivery receipt library across the workspace",
    "Land the invoice and delivery receipt change in a single commit",
  ]) {
    const decision = decide(wording, workspaceIndex());
    assert.equal(
      decision.reason,
      "atomic_objective",
      `expected an atomicity veto for: ${wording}`,
    );
    assert.equal(decision.split, false);
    assert.equal(decision.subtasks.length, 0);
  }
});

test("atomic signals are reported so a refusal can be argued with", () => {
  assert.deepEqual(atomicSignals("Rename the field everywhere"), [
    "rename",
    "everywhere",
  ]);
  assert.deepEqual(atomicSignals("Add a column to invoices"), []);
});

test("modules coupled by an import between the estimated files stay one task", () => {
  const index = workspaceIndex([
    {
      fromFile: "services/notifications/src/receipt.ts",
      toFile: "services/billing/src/invoice.ts",
      resource: "services/billing/src/invoice.ts",
      kind: "import",
    },
  ]);
  const decision = decide(SPANNING_OBJECTIVE, index);
  assert.equal(decision.reason, "coupled_modules");
  assert.equal(decision.split, false);
});

test("coupling is judged only among the files the estimate selected", () => {
  // The two modules are connected, but through a file this objective never
  // touches. In a monorepo that is true of nearly every pair, and treating it
  // as coupling would veto every split there is.
  const index = workspaceIndex([
    {
      fromFile: "apps/dashboard/src/screen.ts",
      toFile: "services/billing/src/invoice.ts",
      resource: "services/billing/src/invoice.ts",
      kind: "import",
    },
  ]);
  const decision = decide(SPANNING_OBJECTIVE, index);
  assert.equal(decision.reason, "split");
});

test("symbol references couple modules the import graph missed", () => {
  const index = workspaceIndex();
  const receipt = index.files.find(
    (entry) => entry.path === "services/notifications/src/receipt.ts",
  );
  assert.ok(receipt);
  receipt.referencedSymbols = ["createInvoice"];
  const decision = decide(SPANNING_OBJECTIVE, index);
  assert.equal(decision.reason, "coupled_modules");
});

test("couplePieces merges transitively", () => {
  const index = workspaceIndex([
    {
      fromFile: "services/notifications/src/receipt.ts",
      toFile: "services/billing/src/invoice.ts",
      resource: "services/billing/src/invoice.ts",
      kind: "import",
    },
  ]);
  const estimate = estimateScope(SPANNING_OBJECTIVE, index);
  const pieces = couplePieces(estimate, index);
  assert.equal(pieces.length, 1);
  assert.deepEqual(pieces[0]?.modules, [
    "services/billing",
    "services/notifications",
  ]);
});

test("an unknown footprint is never split", () => {
  const decision = decide(
    "Investigate why the nightly pipeline is flaky",
    workspaceIndex(),
  );
  assert.equal(decision.reason, "unknown_scope");
});

test("a weak footprint is never split", () => {
  const estimate: ScopeEstimate = {
    confidence: "weak",
    revision: "c".repeat(40),
    tokens: ["telemetry"],
    namedPaths: [],
    namedDirectories: [],
    files: [
      { path: "a/one.ts", score: 2, reasons: [], anchored: false },
      { path: "b/two.ts", score: 2, reasons: [], anchored: false },
      { path: "a/three.ts", score: 2, reasons: [], anchored: false },
      { path: "b/four.ts", score: 2, reasons: [], anchored: false },
    ],
    modules: [
      { root: "a", files: ["a/one.ts", "a/three.ts"], score: 4, anchored: false },
      { root: "b", files: ["b/two.ts", "b/four.ts"], score: 4, anchored: false },
    ],
    indexTruncated: false,
    notes: [],
  };
  const decision = decomposeTask({
    objective: "Reduce telemetry volume",
    estimate,
    index: workspaceIndex(),
    options: { mode: "always" },
  });
  assert.equal(decision.reason, "weak_scope");
});

test("a small footprint is not worth dividing", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex(), [], {
    mode: "always",
    minFiles: 99,
  });
  assert.equal(decision.reason, "too_small");
});

test("a single-module footprint has nothing to separate", () => {
  const decision = decide(
    "Adjust the invoice tax rate",
    workspaceIndex(),
    [],
    { mode: "always", minFiles: 1 },
  );
  assert.equal(decision.reason, "single_module");
});

test("a piece too thin to stand alone is refused, never dropped", () => {
  // Without this, raising the per-piece minimum would silently discard the
  // notifications half of the objective: no task would own it.
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex(), [], {
    mode: "always",
    minFilesPerSubtask: 3,
  });
  assert.equal(decision.reason, "too_fragmented");
  assert.equal(decision.split, false);
  assert.ok(decision.explanation.includes("would lose part of the objective"));
});

test("a footprint that spreads too far is distrusted rather than acted on", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex(), [], {
    mode: "always",
    maxSubtasks: 1,
  });
  assert.equal(decision.reason, "too_fragmented");
});

test("without contention the default mode declines to split", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex(), [], {});
  assert.equal(decision.reason, "no_contention");
  assert.equal(decision.split, false);
});

test("contention on one module makes the split worth its cost", () => {
  const decision = decide(
    SPANNING_OBJECTIVE,
    workspaceIndex(),
    [
      {
        taskId: "task-running",
        source: "lease",
        modules: ["services/billing"],
        files: ["services/billing/src/invoice.ts"],
      },
    ],
    {},
  );
  assert.equal(decision.reason, "split");
  assert.deepEqual(decision.contendingTaskIds, ["task-running"]);
  const billing = decision.subtasks.find((subtask) =>
    subtask.modules.includes("services/billing"),
  );
  const notifications = decision.subtasks.find((subtask) =>
    subtask.modules.includes("services/notifications"),
  );
  assert.equal(billing?.contended, true);
  assert.equal(notifications?.contended, false);
});

test("contention on every module means no split can relieve it", () => {
  const decision = decide(
    SPANNING_OBJECTIVE,
    workspaceIndex(),
    [
      {
        taskId: "task-a",
        source: "lease",
        modules: ["services/billing"],
      },
      {
        taskId: "task-b",
        source: "queued",
        modules: ["services/notifications"],
      },
    ],
    {},
  );
  assert.equal(decision.reason, "no_relief");
  assert.deepEqual(decision.contendingTaskIds, ["task-a", "task-b"]);
});

test("contention recorded only as leased files still counts", () => {
  const decision = decide(
    SPANNING_OBJECTIVE,
    workspaceIndex(),
    [
      {
        taskId: "task-running",
        source: "lease",
        modules: [],
        files: ["services/billing/src/tax.ts"],
      },
    ],
    {},
  );
  assert.equal(decision.reason, "split");
});

test("a mode is parsed exactly or refused", () => {
  assert.equal(parseDecompositionMode(undefined), "contended");
  assert.equal(parseDecompositionMode(""), "contended");
  assert.equal(parseDecompositionMode("off"), "off");
  assert.equal(parseDecompositionMode(" always "), "always");
  assert.throws(
    () => parseDecompositionMode("Always"),
    /Unknown task decomposition mode/u,
  );
  assert.throws(
    () => parseDecompositionMode("on"),
    /Expected off, contended, always/u,
  );
});

test("the feature can be turned off outright", () => {
  const decision = decide(SPANNING_OBJECTIVE, workspaceIndex(), [], {
    mode: "off",
  });
  assert.equal(decision.reason, "disabled");
  assert.equal(decision.split, false);
});
