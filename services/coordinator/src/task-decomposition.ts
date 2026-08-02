import type { RepositoryIndex } from "@coord/code-intelligence";

import type { ScopeEstimate } from "./scope-estimation.js";

/**
 * Splitting a large task into smaller, non-overlapping ones before an agent
 * ever sees it.
 *
 * Everything else in this coordinator treats conflict as something that
 * happens and then has to be handled: detected in plans, arbitrated at
 * admission, sequenced, or repaired at integration. All of it is downstream of
 * a decision nobody was making — how much of the repository one task is
 * allowed to be about. A task whose footprint spans four independent modules
 * holds leases on four independent modules for its whole life, and every
 * concurrent task that needs any of them waits, replans, or collides. Split
 * the same work into four tasks and three of those collisions never exist.
 *
 * The lever is real but it is sharp, because a bad split is worse than no
 * split: two halves of a change that had to compile together produce two
 * changesets that each fail validation, and the platform pays for two agent
 * runs to get less than one. So the whole design is a series of reasons *not*
 * to split, and the default answer is no.
 *
 * A split is proposed only when all of this holds:
 *
 *  1. The pre-agent estimate is anchored. Splitting on ignorance is the worst
 *     case, so an objective the repository cannot recognize is never split.
 *  2. The footprint is genuinely large — several files across several of the
 *     repository's own module roots.
 *  3. The objective carries no atomicity signal. Renames, refactors, moves,
 *     migrations and version bumps are exactly the changes that must land
 *     together to compile, and they announce themselves in the wording.
 *  4. The candidate pieces are not coupled. Two modules whose *estimated*
 *     files import each other or reference each other's symbols are merged
 *     into one piece rather than separated; if everything merges into one
 *     piece, there is no split.
 *  5. The split is not absurdly fine. More pieces than the cap means the
 *     estimate has spread rather than localized, which is a reason to distrust
 *     it, not to act on it.
 *  6. In the default mode, the split actually buys something: some other task
 *     is already contending for part of this footprint, and at least one piece
 *     of the split is free of that contention. Splitting costs coherence and
 *     extra runs; paying that price for a repository nobody else is touching
 *     is a bad trade.
 *
 * Only condition 6 is about contention, and it is the one most likely to be
 * argued with, so it is a mode rather than a rule: `off` disables the feature,
 * `contended` (the default) requires the relief above, and `always` proposes a
 * split whenever conditions 1-5 hold.
 */

export type DecompositionMode = "off" | "contended" | "always";

export const DECOMPOSITION_MODES: readonly DecompositionMode[] = [
  "off",
  "contended",
  "always",
];

/**
 * Reads a mode from configuration or a command line, rejecting anything else.
 *
 * A misspelt mode must never quietly become the default. The difference
 * between "off" and "contended" is whether one submitted objective can become
 * several tasks, and whoever wrote the value is entitled to control that
 * exactly rather than approximately.
 */
export function parseDecompositionMode(
  value: string | undefined,
): DecompositionMode {
  if (value === undefined || value.trim().length === 0) {
    return "contended";
  }
  const candidate = value.trim();
  if ((DECOMPOSITION_MODES as readonly string[]).includes(candidate)) {
    return candidate as DecompositionMode;
  }
  throw new Error(
    `Unknown task decomposition mode: ${value}. ` +
      `Expected ${DECOMPOSITION_MODES.join(", ")}.`,
  );
}

export type DecompositionReason =
  | "disabled"
  | "unknown_scope"
  | "weak_scope"
  | "too_small"
  | "single_module"
  | "atomic_objective"
  | "coupled_modules"
  | "too_fragmented"
  | "no_contention"
  | "no_relief"
  | "split";

export interface DecompositionOptions {
  mode?: DecompositionMode;
  /** Fewest estimated files that can justify a split. Default 4. */
  minFiles?: number;
  /** Fewest independent pieces a split must produce. Default 2. */
  minSubtasks?: number;
  /** Most pieces a split may produce before it is distrusted. Default 4. */
  maxSubtasks?: number;
  /** Fewest estimated files a single piece may carry. Default 1. */
  minFilesPerSubtask?: number;
}

/**
 * Work already in flight that a new task would contend with.
 *
 * `files` is the strong form — real leases held by a running task, which is a
 * declared scope rather than a guess. `modules` is the weak form, used for
 * queued work that has no plan yet and whose footprint was estimated the same
 * way this task's was.
 */
export interface ContendingWork {
  taskId: string;
  /** How the contention should be described to a human. */
  source: "lease" | "queued";
  modules: string[];
  files?: string[];
}

export interface SubtaskProposal {
  /** 1-based position, only for describing the split to a human. */
  position: number;
  total: number;
  modules: string[];
  files: string[];
  objective: string;
  /** Whether this piece still overlaps the contention that motivated the split. */
  contended: boolean;
}

export interface DecompositionInput {
  objective: string;
  estimate: ScopeEstimate;
  index: RepositoryIndex;
  contention?: readonly ContendingWork[];
  options?: DecompositionOptions;
}

export interface DecompositionDecision {
  split: boolean;
  reason: DecompositionReason;
  explanation: string;
  subtasks: SubtaskProposal[];
  /** Contending task ids that motivated, or failed to motivate, the split. */
  contendingTaskIds: string[];
}

/**
 * Wordings that mean "this change has to land in one piece".
 *
 * Each is a change shape whose edits are mutually dependent by construction: a
 * rename is not a rename until every reference moves, an extraction leaves the
 * origin broken until the destination exists, a version bump that lands in
 * half the workspaces does not build. Matching here is a veto, not a score,
 * and the matched phrase is quoted back so the decision can be argued with.
 *
 * False positives are cheap — the task is submitted whole, exactly as it would
 * have been before this module existed. False negatives are expensive. The
 * list is therefore generous.
 */
const ATOMIC_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brenam(?:e|es|ed|ing)\b/iu, "rename"],
  [/\brefactor(?:s|ed|ing)?\b/iu, "refactor"],
  [/\bextract(?:s|ed|ing)?\b/iu, "extract"],
  [/\binlin(?:e|es|ed|ing)\b/iu, "inline"],
  [/\bmov(?:e|es|ed|ing)\b/iu, "move"],
  [/\bmigrat(?:e|es|ed|ing|ion)\b/iu, "migrate"],
  [/\bupgrad(?:e|es|ed|ing)\b/iu, "upgrade"],
  [/\bbump\b/iu, "bump"],
  [/\bsignatures?\b/iu, "signature"],
  [/\bcall ?sites?\b/iu, "call site"],
  [/\bacross\b/iu, "across"],
  [/\beverywhere\b/iu, "everywhere"],
  [/\brepo(?:sitory)?[- ]wide\b/iu, "repository-wide"],
  [/\batomic(?:ally)?\b/iu, "atomic"],
  [/\b(?:a |one |single )commit\b/iu, "single commit"],
  [/\bin lockstep\b/iu, "lockstep"],
  [/\btogether\b/iu, "together"],
  [/\bend[- ]to[- ]end\b/iu, "end-to-end"],
  [/\bconsistent(?:ly)?\b/iu, "consistent"],
  [/\bunif(?:y|ies|ied|ying)\b/iu, "unify"],
  [/\bconsolidat(?:e|es|ed|ing|ion)\b/iu, "consolidate"],
  [/\bcentraliz(?:e|es|ed|ing|ation)\b/iu, "centralize"],
  [/\bdeprecat(?:e|es|ed|ing|ion)\b/iu, "deprecate"],
  [/\brewrit(?:e|es|ing)\b/iu, "rewrite"],
  [/\bsame time\b/iu, "same time"],
  [/\ball (?:the )?(?:callers|consumers|usages|references|imports)\b/iu, "all callers"],
];

/** The atomicity wordings an objective contains, if any. */
export function atomicSignals(objective: string): string[] {
  return ATOMIC_SIGNALS.filter(([pattern]) => pattern.test(objective)).map(
    ([, label]) => label,
  );
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  public add(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
    }
  }

  public find(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) {
      return key;
    }
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  public union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent.set(leftRoot, rightRoot);
    }
  }
}

interface CandidatePiece {
  modules: string[];
  files: string[];
}

/**
 * Merges module footprints that the estimated files themselves couple.
 *
 * Coupling is judged only among files the estimate already selected, never
 * across the whole repository. In a monorepo every package imports the shared
 * types package, so "these two modules are connected somewhere" is true of
 * everything and would veto every split. "The file I am about to change in A
 * imports the file I am about to change in B" is the question that actually
 * predicts whether the two halves have to compile together.
 */
export function couplePieces(
  estimate: ScopeEstimate,
  index: RepositoryIndex,
): CandidatePiece[] {
  const selected = new Set(estimate.files.map((file) => file.path));
  const moduleOf = new Map<string, string>();
  for (const footprint of estimate.modules) {
    for (const file of footprint.files) {
      moduleOf.set(file, footprint.root);
    }
  }

  const sets = new DisjointSet();
  for (const footprint of estimate.modules) {
    sets.add(footprint.root);
  }

  for (const edge of index.edges) {
    if (edge.toFile === undefined) {
      continue;
    }
    if (!selected.has(edge.fromFile) || !selected.has(edge.toFile)) {
      continue;
    }
    const from = moduleOf.get(edge.fromFile);
    const to = moduleOf.get(edge.toFile);
    if (from !== undefined && to !== undefined && from !== to) {
      sets.union(from, to);
    }
  }

  // Symbol-level coupling: a selected file that references a symbol another
  // selected file declares is the same dependency the import graph would show
  // if the indexer had resolved the import, and often it could not.
  const declaredBy = new Map<string, Set<string>>();
  for (const file of index.files) {
    if (!selected.has(file.path)) {
      continue;
    }
    for (const symbol of file.symbols) {
      const entry = declaredBy.get(symbol) ?? new Set<string>();
      entry.add(file.path);
      declaredBy.set(symbol, entry);
    }
  }
  for (const file of index.files) {
    if (!selected.has(file.path)) {
      continue;
    }
    const consumer = moduleOf.get(file.path);
    if (consumer === undefined) {
      continue;
    }
    for (const referenced of file.referencedSymbols) {
      for (const producerFile of declaredBy.get(referenced) ?? []) {
        const producer = moduleOf.get(producerFile);
        if (producer !== undefined && producer !== consumer) {
          sets.union(consumer, producer);
        }
      }
    }
  }

  const merged = new Map<string, CandidatePiece>();
  for (const footprint of estimate.modules) {
    const root = sets.find(footprint.root);
    const piece = merged.get(root) ?? { modules: [], files: [] };
    piece.modules.push(footprint.root);
    piece.files.push(...footprint.files);
    merged.set(root, piece);
  }

  return [...merged.values()]
    .map((piece) => ({
      modules: [...new Set(piece.modules)].sort(),
      files: [...new Set(piece.files)].sort(),
    }))
    .sort((left, right) => {
      const leftKey = left.modules[0] ?? "";
      const rightKey = right.modules[0] ?? "";
      return leftKey.localeCompare(rightKey);
    });
}

function describeModules(modules: readonly string[]): string {
  const named = modules.map((entry) =>
    entry === "" ? "the repository root" : entry,
  );
  if (named.length <= 2) {
    return named.join(" and ");
  }
  return `${named.slice(0, -1).join(", ")}, and ${named[named.length - 1] ?? ""}`;
}

/**
 * The objective one piece of a split is given.
 *
 * The original wording is kept verbatim and a scope constraint is appended,
 * rather than the objective being rewritten. Rewriting would mean this module
 * deciding what the task means, which it has no basis for — it has matched
 * some words against an index, not understood the work. Appending leaves the
 * author's intent intact and adds the one thing intake actually knows: which
 * part of the repository this copy is responsible for, and who is covering the
 * rest.
 */
export function subtaskObjective(
  original: string,
  piece: CandidatePiece,
  position: number,
  total: number,
  otherModules: readonly string[],
): string {
  const lines = [
    original.trim(),
    "",
    `Scope constraint (part ${position} of ${total}): confine this task to ` +
      `${describeModules(piece.modules)}.`,
    `Files expected in scope: ${piece.files.join(", ")}.`,
  ];
  if (otherModules.length > 0) {
    lines.push(
      `Sibling tasks cover ${describeModules(otherModules)}; do not change ` +
        "anything there, and do not wait for them.",
    );
  }
  lines.push(
    "This split was made at intake from an estimate, not from a plan. If the " +
      "work genuinely cannot be completed within this scope, request a scope " +
      "change rather than editing outside it.",
  );
  return lines.join("\n");
}

function decision(
  reason: DecompositionReason,
  explanation: string,
  contendingTaskIds: string[] = [],
  subtasks: SubtaskProposal[] = [],
): DecompositionDecision {
  return {
    split: reason === "split",
    reason,
    explanation,
    subtasks,
    contendingTaskIds,
  };
}

/**
 * Decides whether one objective should enter the queue as several tasks.
 *
 * Pure: the caller supplies the estimate, the index, and what is already in
 * flight, and receives a decision plus, when it splits, the exact objectives
 * to submit. Nothing here reads a store or a clock, so the whole policy is
 * testable against fixtures and reproducible in an audit.
 */
export function decomposeTask(
  input: DecompositionInput,
): DecompositionDecision {
  const options = input.options ?? {};
  const mode = options.mode ?? "contended";
  const minFiles = options.minFiles ?? 4;
  const minSubtasks = options.minSubtasks ?? 2;
  const maxSubtasks = options.maxSubtasks ?? 4;
  const minFilesPerSubtask = options.minFilesPerSubtask ?? 1;
  const contention = input.contention ?? [];

  if (mode === "off") {
    return decision("disabled", "Intake decomposition is disabled.");
  }

  const { estimate } = input;
  if (estimate.confidence === "none") {
    return decision(
      "unknown_scope",
      "Nothing in the objective matches the repository, so its footprint is " +
        "unknown. Splitting an unknown footprint would be guessing.",
    );
  }
  if (estimate.confidence === "weak") {
    return decision(
      "weak_scope",
      "The objective matched only file names — no directory, symbol, or " +
        "declared resource — which is too thin to divide work on.",
    );
  }
  if (estimate.files.length < minFiles) {
    return decision(
      "too_small",
      `The estimated footprint is ${estimate.files.length} file(s), below the ` +
        `${minFiles} needed to be worth dividing.`,
    );
  }
  if (estimate.modules.length < minSubtasks) {
    return decision(
      "single_module",
      `The estimated footprint sits in one module ` +
        `(${describeModules(estimate.modules.map((entry) => entry.root))}); ` +
        "there is nothing independent to separate.",
    );
  }

  const signals = atomicSignals(input.objective);
  if (signals.length > 0) {
    return decision(
      "atomic_objective",
      `The objective reads as one indivisible change (${signals
        .map((signal) => `"${signal}"`)
        .join(", ")}); its parts most likely have to land together.`,
    );
  }

  const pieces = couplePieces(estimate, input.index);
  // A piece below the minimum is never dropped, only refused. Dropping it
  // would quietly discard part of the objective: the work in that module would
  // belong to no task at all, and nothing downstream would notice.
  const thin = pieces.filter(
    (piece) => piece.files.length < minFilesPerSubtask,
  );
  if (thin.length > 0) {
    return decision(
      "too_fragmented",
      `A piece of this split (${describeModules(
        thin.flatMap((piece) => piece.modules),
      )}) would carry fewer than ${minFilesPerSubtask} files, and dropping it ` +
        "would lose part of the objective.",
    );
  }
  if (pieces.length < minSubtasks) {
    return decision(
      "coupled_modules",
      "The modules in the estimated footprint depend on each other, so " +
        "dividing them would split a change that has to compile as one.",
    );
  }
  if (pieces.length > maxSubtasks) {
    return decision(
      "too_fragmented",
      `The estimate spreads across ${pieces.length} independent pieces, more ` +
        `than the ${maxSubtasks} a trustworthy split should produce; the ` +
        "footprint looks diffuse rather than localized.",
    );
  }

  const contendedModules = new Set(
    contention.flatMap((entry) => entry.modules),
  );
  const contendedFiles = new Set(
    contention.flatMap((entry) => entry.files ?? []),
  );
  const overlaps = (piece: CandidatePiece): boolean =>
    piece.modules.some((module) => contendedModules.has(module)) ||
    piece.files.some((file) => contendedFiles.has(file));

  const contendedPieces = pieces.filter((piece) => overlaps(piece));
  const freePieces = pieces.filter((piece) => !overlaps(piece));
  const contendingTaskIds = [
    ...new Set(contention.map((entry) => entry.taskId)),
  ].sort();

  if (mode === "contended") {
    if (contendedPieces.length === 0) {
      return decision(
        "no_contention",
        "No other task is contending for this footprint, so a split would " +
          "cost coherence and buy nothing.",
        contendingTaskIds,
      );
    }
    if (freePieces.length === 0) {
      return decision(
        "no_relief",
        "Every part of this footprint is already contended, so no split of " +
          "it can run free of the work in flight.",
        contendingTaskIds,
      );
    }
  }

  const total = pieces.length;
  const subtasks = pieces.map((piece, order): SubtaskProposal => {
    const position = order + 1;
    const otherModules = pieces
      .filter((_entry, otherOrder) => otherOrder !== order)
      .flatMap((entry) => entry.modules);
    return {
      position,
      total,
      modules: piece.modules,
      files: piece.files,
      objective: subtaskObjective(
        input.objective,
        piece,
        position,
        total,
        otherModules,
      ),
      contended: overlaps(piece),
    };
  });

  const explanation =
    mode === "contended"
      ? `Split into ${total} independent tasks: ${freePieces.length} of them ` +
        `avoid the footprint that ${contendingTaskIds.length} task(s) already ` +
        "hold, which the undivided task would have collided with."
      : `Split into ${total} independent tasks along module boundaries ` +
        `(${describeModules(pieces.flatMap((piece) => piece.modules))}), none ` +
        "of which depend on another's estimated files.";

  return decision("split", explanation, contendingTaskIds, subtasks);
}
