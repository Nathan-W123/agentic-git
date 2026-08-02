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
  manifestOnly,
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
 *
 * The dashboard carries a dozen files the objective never mentions, and that
 * bulk is load-bearing rather than decorative. An earlier version of this
 * fixture held five files total, so the four-file estimate was eighty per cent
 * of the repository — a proportion the precision guard now refuses outright,
 * and rightly, because a task touching most of a repository is not one anybody
 * should be dividing. A fixture that only passes because it is tiny would be
 * testing the policy against a repository shape it is meant to reject.
 */
function workspaceIndex(edges: DependencyEdge[] = []): RepositoryIndex {
  const unrelated = [
    "chart",
    "filter",
    "header",
    "layout",
    "legend",
    "palette",
    "sidebar",
    "sparkline",
    "theme",
    "toolbar",
    "tooltip",
  ].map((name) =>
    file(`apps/dashboard/src/${name}.ts`, {
      symbols: [`render${name[0]?.toUpperCase()}${name.slice(1)}`],
    }),
  );
  const files = [
    // `currencyCode` is here so the objective below is not balanced exactly on
    // the token-coverage threshold: a billing service that has never heard of
    // currency would make "give invoices a currency column" a half-unknown
    // request, and the test would then be asserting the split policy while
    // sitting one word away from a different verdict.
    file("services/billing/src/invoice.ts", {
      symbols: ["createInvoice", "InvoiceLine", "currencyCode"],
    }),
    file("services/billing/src/tax.ts", { symbols: ["invoiceTaxRate"] }),
    file("services/notifications/src/receipt.ts", {
      symbols: ["deliveryReceipt"],
    }),
    file("services/notifications/src/queue.ts", {
      symbols: ["deliveryQueue"],
    }),
    file("apps/dashboard/src/screen.ts", { symbols: ["renderScreen"] }),
    ...unrelated,
  ];
  return {
    repositoryId: "example",
    revision: "b".repeat(40),
    generatedAt: "2026-01-01T00:00:00.000Z",
    files,
    edges,
    paths: [
      ...files.map((entry) => entry.path),
      "apps/dashboard/package.json",
      "services/billing/package.json",
      "services/notifications/package.json",
    ].sort(),
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
    unmatchedTokens: [],
    repositoryFraction: 0.1,
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

/**
 * The failure a replay against recorded runs actually found.
 *
 * A sixteen-file chess backend, and the objective "generate the frontend of
 * the game chess". The frontend does not exist yet, so the only words the
 * index can see are "chess" and "game" — which name most of that repository
 * and localize nothing in it. The estimator matched them against the backend,
 * called itself anchored, and the policy split a task whose real footprint
 * was fourteen files in a `frontend/` tree that shared not one path with the
 * estimate. Neither the atomicity nor the coupling veto could see it: the
 * wording announces nothing indivisible and the wrongly-chosen files really
 * are structurally independent of each other.
 */
function chessBackendIndex(): RepositoryIndex {
  const files = [
    file("src/chess/engine.ts", { symbols: ["ChessEngine", "applyChessMove"] }),
    file("src/chess/types.ts", { symbols: ["ChessMove", "ChessPiece"] }),
    // The service layer of a chess server names chess in its own types, which
    // is exactly why the word cannot localize anything inside this repository.
    file("src/games/game-service.ts", {
      symbols: ["GameService", "ChessGameState"],
    }),
    file("src/games/game-store.ts", { symbols: ["GameStore", "ChessGameRow"] }),
    file("src/routes/games.ts", { symbols: ["registerGameRoutes"] }),
    file("src/websocket/game-events.ts", { symbols: ["GameEventSocket"] }),
    file("tests/chess-engine.test.ts", { symbols: ["chessEngineSuite"] }),
    file("tests/game-service.test.ts", { symbols: ["gameServiceSuite"] }),
    file("tests/games-api.test.ts", { symbols: ["gamesApiSuite"] }),
    file("src/server.ts", { symbols: ["startServer"] }),
    file("src/config.ts", { symbols: ["loadSettings"] }),
    file("src/logging.ts", { symbols: ["logLine"] }),
    file("package.json", { language: "json" }),
    file("package-lock.json", { language: "json" }),
  ];
  return {
    repositoryId: "chess",
    revision: "d".repeat(40),
    generatedAt: "2026-01-01T00:00:00.000Z",
    files,
    edges: [],
    paths: [...files.map((entry) => entry.path), "README.md"].sort(),
    truncated: false,
    skippedFiles: 0,
  };
}

test("a domain word that names most of a small repository localizes nothing", () => {
  const estimate = estimateScope(
    "generate the frontend of the game chess",
    chessBackendIndex(),
  );
  // "chess" and "game" each reach more files than the ubiquity limit allows,
  // so nothing survives to be believed.
  assert.equal(estimate.confidence, "none");
  assert.deepEqual(estimate.tokens, []);
  assert.ok(estimate.unmatchedTokens.includes("frontend"));
  assert.ok(
    estimate.notes.some((note) => note.includes("too common to localize")),
  );
});

test("the replayed zero-overlap objective is now vetoed, not split", () => {
  const decision = decide(
    "generate the frontend of the game chess",
    chessBackendIndex(),
  );
  assert.equal(decision.split, false);
  assert.equal(decision.reason, "unknown_scope");
});

test("an estimate covering much of the repository is refused as a selection", () => {
  // The ubiquity filter turned off, to prove the precision guard stands on its
  // own rather than being shadowed by the filter that happens to fire first.
  const index = chessBackendIndex();
  const objective = "rework the game chess engine store routes and events";
  const estimate = estimateScope(objective, index, { ubiquityRatio: 1 });
  assert.equal(estimate.confidence, "anchored");
  assert.ok(estimate.repositoryFraction > 0.35);

  const decision = decomposeTask({
    objective,
    estimate,
    index,
    options: { mode: "always" },
  });
  assert.equal(decision.reason, "diffuse_estimate");
  assert.equal(decision.split, false);
  assert.ok(decision.explanation.includes("% of the indexed repository"));
});

test("words the repository has never seen are recorded but decide nothing", () => {
  // Deliberately not a veto. A version of this policy vetoed on the share of
  // content words the index could not find, and replay showed it firing on the
  // best estimate in the corpus because that objective's unmatched words were
  // "repair" and "synchronize" — stop-list gaps, not absent subjects. The
  // signal is kept visible and left inert.
  const index = workspaceIndex();
  const objective = "add kubernetes helm terraform manifests for invoices";
  const estimate = estimateScope(objective, index);
  assert.ok(estimate.unmatchedTokens.length > estimate.tokens.length);
  assert.ok(estimate.unmatchedTokens.includes("terraform"));

  const decision = decomposeTask({
    objective,
    estimate,
    index,
    options: { mode: "always" },
  });
  assert.notEqual(decision.reason, "unknown_scope");
  assert.ok(
    decision.reason === "too_small" || decision.reason === "single_module",
    `unexpected reason: ${decision.reason}`,
  );
});

test("a piece of nothing but manifests is not a task of its own", () => {
  assert.equal(manifestOnly(["package.json", "package-lock.json"]), true);
  assert.equal(manifestOnly(["README.md", "docs/guide.md"]), true);
  assert.equal(manifestOnly(["package.json", "src/app.ts"]), false);
  assert.equal(manifestOnly([]), false);

  // Billing and notifications are separable, but the objective also drags in
  // the root lockfiles, which would become a third task holding nothing but
  // bookkeeping.
  const index = workspaceIndex();
  index.files.push(
    file("package.json", { language: "json" }),
    file("package-lock.json", { language: "json" }),
  );
  index.paths.push("package.json", "package-lock.json");
  const objective =
    "Give invoices a currency column, give delivery receipts a timestamp, " +
    "and record it all in package.json";
  const decision = decomposeTask({
    objective,
    estimate: estimateScope(objective, index),
    index,
    options: { mode: "always" },
  });
  assert.equal(decision.reason, "manifest_only_piece");
  assert.equal(decision.split, false);
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
