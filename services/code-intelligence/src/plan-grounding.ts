import path from "node:path";

import {
  uniqueRepositoryPaths,
  uniqueStrings,
  type AgentPlan,
  type GroundedFileReference,
  type GroundedSymbolReference,
  type PlanGrounding,
  type PlanGroundingConfidence,
} from "@coord/shared-types";

import type { RepositoryIndex } from "./index.js";

/**
 * Verifies a plan's declarations against the repository they were written for.
 *
 * Admission arbitrates on what an agent says it will touch, and an agent says
 * that before it has edited anything — sometimes before it has read anything.
 * A live experiment showed exactly what that costs: two agents each invented a
 * name for the same real function, the invented names did not overlap, and the
 * coordinator granted both tasks free concurrency straight into a collision
 * the integration backstop then paid for with a full agent rerun.
 *
 * Grounding closes that gap deterministically. Every declared file either
 * exists at the base revision or it does not; every declared symbol either
 * resolves in the index or it does not. What does not resolve is mapped, where
 * possible, to its likely real counterpart — by basename for files, by
 * identifier-token overlap for symbols — and those referents are what
 * arbitration adds to the plan's footprint. Two plans that misname the same
 * real code in different ways collide on the referent even though their
 * declared names never touch.
 *
 * Everything here is a static check against the index: no model call, no
 * heuristic an audit trail cannot replay.
 */

/**
 * Identifier fragments too generic to anchor a symbol match on their own.
 *
 * `calculateTotal` should reach `orderTotal` because they share "total", not
 * because half the repository shares "calculate". The list is short and biased
 * toward verbs: a noun is usually what a function is about, a verb is usually
 * how it phrases it.
 */
export const GENERIC_IDENTIFIER_TOKENS = new Set([
  "add",
  "apply",
  "build",
  "calc",
  "calculate",
  "can",
  "check",
  "compute",
  "create",
  "default",
  "delete",
  "do",
  "exec",
  "fetch",
  "fn",
  "func",
  "function",
  "get",
  "handle",
  "has",
  "helper",
  "helpers",
  "impl",
  "index",
  "init",
  "is",
  "load",
  "main",
  "make",
  "new",
  "process",
  "read",
  "remove",
  "run",
  "save",
  "set",
  "setup",
  "should",
  "update",
  "util",
  "utils",
  "will",
  "write",
]);

/** How many real counterparts one unresolved declaration may be mapped to. */
const MAX_REFERENTS = 3;

/** Lowercased word fragments of one identifier: camelCase, snake_case, digits. */
export function identifierTokens(name: string): string[] {
  return (
    name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/gu) ?? []
  ).map((token) => token.toLowerCase());
}

function contentTokens(name: string): Set<string> {
  return new Set(
    identifierTokens(name).filter(
      (token) => !GENERIC_IDENTIFIER_TOKENS.has(token) && token.length > 1,
    ),
  );
}

interface SymbolCandidate {
  name: string;
  files: string[];
}

interface ScoredSymbol extends SymbolCandidate {
  score: number;
}

/**
 * Real symbols an unresolved declared name plausibly refers to.
 *
 * A candidate matches when the declaration's content tokens are all present in
 * it, or when the two share at least half their combined content tokens. Both
 * rules require a shared token that is not generic, so `calculateTotal`
 * reaches `orderTotal` through "total" while `getData` reaches nothing.
 */
function symbolReferentsFor(
  declared: string,
  candidates: readonly SymbolCandidate[],
): ScoredSymbol[] {
  const declaredTokens = contentTokens(declared);
  if (declaredTokens.size === 0) {
    return [];
  }
  const scored: ScoredSymbol[] = [];
  for (const candidate of candidates) {
    const candidateTokens = contentTokens(candidate.name);
    const shared = [...declaredTokens].filter((token) =>
      candidateTokens.has(token),
    );
    if (shared.length === 0) {
      continue;
    }
    const union = new Set([...declaredTokens, ...candidateTokens]);
    const score = shared.length / union.size;
    if (shared.length === declaredTokens.size || score >= 0.5) {
      scored.push({ ...candidate, score });
    }
  }
  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.name.length - right.name.length ||
        left.name.localeCompare(right.name),
    )
    .slice(0, MAX_REFERENTS);
}

/**
 * Real files a missing declared path plausibly refers to: same basename, or
 * the declared path is a suffix of the real one. `src/order.js` reaches
 * `src/models/order.js`; an invented `src/checkout.js` reaches nothing.
 */
function fileReferentsFor(
  declared: string,
  paths: readonly string[],
): string[] {
  const basename = path.posix.basename(declared).toLowerCase();
  const suffix = `/${declared.toLowerCase()}`;
  return paths
    .filter((candidate) => {
      const lowered = candidate.toLowerCase();
      return (
        path.posix.basename(lowered) === basename ||
        lowered.endsWith(suffix)
      );
    })
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_REFERENTS);
}

/**
 * Kill switch, and the control arm of the before/after measurement.
 *
 * With `COORD_DISABLE_PLAN_GROUNDING=1` every plan passes through unverified
 * and arbitration behaves exactly as it did before grounding existed. That is
 * strictly less safe — it is the recorded failure mode — so it exists only
 * for operational rollback and for benchmarking the fix against its absence
 * on an otherwise identical build.
 */
function groundingDisabled(): boolean {
  return process.env["COORD_DISABLE_PLAN_GROUNDING"] === "1";
}

/**
 * Returns the plan with a freshly computed grounding record.
 *
 * Always overwrites any grounding already present: this is a coordinator-side
 * verdict about the agent's declarations, and the one place it may come from
 * is the index of the repository the plan will run against.
 */
export function groundPlan(plan: AgentPlan, index: RepositoryIndex): AgentPlan {
  if (groundingDisabled()) {
    const { grounding: ignored, ...bare } = structuredClone(plan);
    void ignored;
    return bare;
  }
  const existingPaths = new Set(index.paths.map((entry) => entry.toLowerCase()));
  const declaredFiles = uniqueRepositoryPaths(plan.expectedFiles);
  const missingFiles = declaredFiles.filter(
    (file) => !existingPaths.has(file.toLowerCase()),
  );

  const symbolFiles = new Map<string, SymbolCandidate>();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      const key = symbol.toLowerCase();
      const entry = symbolFiles.get(key) ?? { name: symbol, files: [] };
      entry.files.push(file.path);
      symbolFiles.set(key, entry);
    }
  }
  const declaredSymbols = uniqueStrings(plan.expectedSymbols);
  const unresolvedSymbols = declaredSymbols.filter(
    (symbol) => !symbolFiles.has(symbol.toLowerCase()),
  );

  const candidates = [...symbolFiles.values()];
  const notes: string[] = [];
  const fileReferents: GroundedFileReference[] = [];
  for (const declared of missingFiles) {
    const resolved = fileReferentsFor(declared, index.paths);
    for (const file of resolved) {
      fileReferents.push({ declared, resolved: file });
    }
    notes.push(
      `declared file ${declared} does not exist at ${index.revision}` +
        (resolved.length === 0
          ? " and matches nothing; treated as a new file"
          : `; arbitrating as if it names ${resolved.join(", ")}`),
    );
  }
  const symbolReferents: GroundedSymbolReference[] = [];
  for (const declared of unresolvedSymbols) {
    const resolved = symbolReferentsFor(declared, candidates);
    for (const match of resolved) {
      symbolReferents.push({
        declared,
        resolved: match.name,
        files: uniqueRepositoryPaths(match.files),
      });
    }
    notes.push(
      `declared symbol ${declared} does not resolve at ${index.revision}` +
        (resolved.length === 0
          ? " and matches nothing; treated as a new symbol"
          : `; arbitrating as if it names ${resolved
              .map((match) => match.name)
              .join(", ")}`),
    );
  }

  const anchored =
    declaredFiles.length > missingFiles.length ||
    declaredSymbols.length > unresolvedSymbols.length ||
    fileReferents.length > 0 ||
    symbolReferents.length > 0;
  let confidence: PlanGroundingConfidence;
  if (missingFiles.length === 0 && unresolvedSymbols.length === 0) {
    confidence = "verified";
  } else if (anchored) {
    confidence = "grounded";
  } else if (index.truncated) {
    // An incomplete index cannot condemn a plan: the declarations may resolve
    // in exactly the files the byte budget skipped.
    confidence = "grounded";
    notes.push(
      "index was truncated; unverifiable declarations are given the benefit of the doubt",
    );
  } else {
    confidence = "ungrounded";
    notes.push(
      "nothing this plan declares exists in the repository; its real footprint is unknown",
    );
  }

  const grounding: PlanGrounding = {
    confidence,
    revision: index.revision,
    missingFiles,
    unresolvedSymbols,
    fileReferents,
    symbolReferents,
    notes,
  };
  return { ...structuredClone(plan), grounding };
}
