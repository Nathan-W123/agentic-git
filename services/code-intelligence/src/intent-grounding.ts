import path from "node:path";

import { intentTerms, lemmaOf, wordNet, type WordNet } from "@coord/intent-analysis";

import { GENERIC_IDENTIFIER_TOKENS, identifierTokens } from "./plan-grounding.js";
import type { RepositoryIndex } from "./index.js";

/**
 * Grounds what a task *says* it wants against the code that actually exists.
 *
 * `plan-grounding.ts` does this for declarations: a plan names files and
 * symbols, some of them invented, and every name is resolved against the index
 * so two plans that misname the same real code still collide on the referent.
 * This module applies the same discipline one step earlier, to the sentence.
 *
 * The reason is a measured failure. `docs/benchmarks/intent-signal.md` records
 * a text-only intent signal — lemmatized, WordNet-corroborated, scored by
 * sentence embeddings — that reads English correctly (96% recall at 0.83
 * median cosine on forty phrasings of one task) and is still useless for
 * scheduling: 0% recall on held-out data, and its single highest-scoring pair
 * was a non-conflict. Two tasks that both change what a customer pays are
 * maximally similar as sentences and perfectly independent as code, because
 * they own different modules. Module ownership is not a property of a
 * sentence, so no operating point on sentence similarity can recover it.
 *
 * What it *is* a property of is the repository, and the repository is indexed.
 * So: take the intent prose, keep the words that name something the index
 * actually contains, and ask which file those words point at. Weight each word
 * by how rare it is across the index, because a word every file answers to
 * ("src", "pricing") locates nothing and a word one file answers to
 * ("webhook", "surcharge") locates it exactly. That weighting is derived from
 * the index, not chosen by hand.
 *
 * Everything here is static, like plan grounding: no model call, no embedding,
 * nothing an audit trail cannot replay from the same index.
 */

/**
 * Paths excluded from grounding.
 *
 * A test file is a shadow of the module it covers — `test/total.test.js`
 * carries the same anchor words as `src/pricing/total.js` — so leaving it in
 * makes every pair that grounds to a module ground to two files for one
 * reason, and inflates every overlap count by exactly the same factor. The
 * scenario's own history says the same thing from the other end: sharing a
 * test file was what collapsed the first team-queue run into two serialised
 * chains.
 */
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./u;

/** How many files one intent may be grounded to. Mirrors plan grounding. */
const MAX_TARGETS = 3;

export interface IntentGroundingOptions {
  /**
   * Weighted-overlap score below which a file is not claimed as a target.
   *
   * The one tuned parameter in this module. See
   * {@link DEFAULT_INTENT_GROUNDING_OPTIONS} for where its value comes from.
   */
  targetFloor: number;
}

/**
 * Chosen on the development half of the registered split, then frozen.
 *
 * `targetFloor` has to sit above the highest *wrong* grounding the development
 * half produces and below the lowest right one. Both edges are real cases from
 * that half, and both are homonyms rather than noise:
 *
 * - Highest wrong: `task_webhook_retry` reaches `src/pricing/total.js` at
 *   0.500, because its intent says "preserving the existing synchronous
 *   delivery API" and `total.js` declares `const DELIVERY`. Just below it,
 *   pricing intents spill onto `src/pricing/discount.js` at up to 0.550 —
 *   `orderTotal` has a local named `discounted`, so the caller answers to
 *   "discount" as well as the module that owns it.
 * - Lowest right: `task_handling_fee` onto `src/pricing/total.js` at 0.773.
 *   Its intent names five things in the repository and only four of them are
 *   in the file it means, because it lists the modules it must not break.
 *
 * 0.65 sits in the middle of (0.550, 0.773] rather than against either edge.
 * Reading a boundary off the edge of a forty-pair sample is fitting the
 * sample; the honest claim the development half supports is that the two
 * classes are separated somewhere in that interval, and the midpoint is what
 * that claim implies.
 *
 * No held-out intent was scored before this value was fixed and committed.
 */
export const DEFAULT_INTENT_GROUNDING_OPTIONS: IntentGroundingOptions = {
  targetFloor: 0.65,
};

export interface IntentTarget {
  /** A real path at the index's revision. */
  file: string;
  /** Weighted overlap between the intent's repository vocabulary and the file's. */
  score: number;
  /** The anchor words that put it here, for the audit trail. */
  anchors: string[];
  /**
   * Symbols declared in this file that the intent's own vocabulary reaches.
   *
   * A file is a coarse thing to claim two tasks collide on. This narrows the
   * claim to the declarations the sentence actually names, which is what the
   * call graph can then be asked about: not "these two files are connected"
   * but "this function calls that one".
   */
  symbols: string[];
}

export interface IntentGrounding {
  revision: string;
  /** Files the intent plausibly concerns, strongest first. */
  targets: IntentTarget[];
  /**
   * Lemmas the intent used that name something in the index at all.
   *
   * Empty means the sentence and the repository have no vocabulary in common,
   * which is a different thing from "concerns no file" and is worth saying
   * separately: it is the case where grounding has no opinion rather than a
   * negative one.
   */
  vocabulary: string[];
  confidence: "grounded" | "ungrounded";
  notes: string[];
}

/** Lowercased, lemmatized content words one identifier or path segment is made of. */
function anchorWords(name: string): string[] {
  return identifierTokens(name)
    .filter((token) => token.length > 1 && !GENERIC_IDENTIFIER_TOKENS.has(token))
    .map((token) => lemmaOf(token));
}

/**
 * The words a file answers to: its path and the names it declares.
 *
 * Declared symbols only — not the symbols it references. A file that imports
 * `discountRate` is not *about* discounts, it is about whatever it does with
 * them, and admitting referenced names would ground every caller to every
 * callee before the import graph has been consulted at all. The graph is used
 * below, deliberately and visibly, as a separate and weaker relation.
 *
 * "Declares" is the index's own definition, which includes locals: a function
 * body containing `const discounted = ...` makes its file answer to
 * "discount". That is deliberately not filtered here. It is the same
 * `file.symbols` plan grounding resolves declarations against, so both
 * groundings see one repository rather than two, and narrowing a module's
 * vocabulary to its public surface is a change to what the indexer records
 * rather than a knob on this signal. It has a visible cost — a caller can be
 * reached directly by an intent that means its callee, which turns an
 * `adjacent` pair into a `shared` one — and that cost is asserted in the
 * tests rather than left to be discovered.
 */
function fileAnchors(file: {
  path: string;
  symbols: readonly string[];
}): Set<string> {
  const anchors = new Set<string>();
  const withoutExtension = file.path.slice(
    0,
    file.path.length - path.posix.extname(file.path).length,
  );
  for (const segment of withoutExtension.split("/")) {
    for (const word of anchorWords(segment)) {
      anchors.add(word);
    }
  }
  for (const symbol of file.symbols) {
    for (const word of anchorWords(symbol)) {
      anchors.add(word);
    }
  }
  return anchors;
}

interface AnchorIndex {
  /** Candidate file path to the words it answers to. */
  byFile: Map<string, Set<string>>;
  /** Candidate file path to each declared symbol and the words it answers to. */
  symbolsByFile: Map<string, Map<string, Set<string>>>;
  /** Inverse document frequency of each anchor word across the candidates. */
  weight: Map<string, number>;
}

/**
 * How much each anchor word narrows the repository down.
 *
 * `ln(files / files carrying the word)`, so a word in every file weighs
 * exactly nothing and a word in one file weighs the most. This is why there is
 * no hand-written list of uninformative path segments here: "src" is in every
 * path and scores zero on its own arithmetic, and in a repository where "src"
 * *is* discriminating it would score accordingly.
 */
/**
 * Anchor sets are derived from the whole index and are the expensive part of
 * grounding. Arbitration grounds every plan against every other, so rebuilding
 * them per call would make the signal quadratic in the repository rather than
 * in the queue. Keyed on the index object itself: a new index is a new object,
 * so a re-indexed revision can never read a stale cache.
 */
const ANCHOR_CACHE = new WeakMap<RepositoryIndex, AnchorIndex>();

function anchorIndexFor(index: RepositoryIndex): AnchorIndex {
  const cached = ANCHOR_CACHE.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const built = anchorIndex(index);
  ANCHOR_CACHE.set(index, built);
  return built;
}

function anchorIndex(index: RepositoryIndex): AnchorIndex {
  const byFile = new Map<string, Set<string>>();
  const symbolsByFile = new Map<string, Map<string, Set<string>>>();
  for (const file of index.files) {
    if (TEST_PATH.test(file.path)) {
      continue;
    }
    byFile.set(file.path, fileAnchors(file));
    const perSymbol = new Map<string, Set<string>>();
    for (const symbol of file.symbols) {
      perSymbol.set(symbol, new Set(anchorWords(symbol)));
    }
    symbolsByFile.set(file.path, perSymbol);
  }
  const documentFrequency = new Map<string, number>();
  for (const anchors of byFile.values()) {
    for (const word of anchors) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const total = byFile.size;
  const weight = new Map<string, number>();
  for (const [word, frequency] of documentFrequency) {
    weight.set(word, Math.log(total / frequency));
  }
  return { byFile, symbolsByFile, weight };
}

function mass(words: Iterable<string>, weight: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const word of words) {
    total += weight.get(word) ?? 0;
  }
  return total;
}

/**
 * Which real files an intent sentence plausibly concerns.
 *
 * The score is the share of the intent's repository vocabulary one file
 * accounts for: matched weight over total weight, both weighted by how rare
 * each word is across the index.
 *
 * Normalising by the sentence rather than by the file, or symmetrically
 * between them, is a decision the development half forced. The index records
 * every variable declaration, locals included, so `src/pricing/total.js`
 * answers to `line`, `discount` and `with` from the body of `orderTotal` as
 * well as to `order` and `total` from its name. Any denominator containing the
 * file's own vocabulary therefore charges a module for being busy, and the
 * busy module is exactly the one everything contends on: under a symmetric
 * Jaccard, `task_card_surcharge` — an intent whose every repository word is a
 * word in `orderTotal`'s name — grounded to nothing at all. What the question
 * actually asks is "how much of what this sentence names does this file
 * account for", and that is one-sided by nature.
 */
export function groundIntent(
  text: string,
  index: RepositoryIndex,
  options: IntentGroundingOptions = DEFAULT_INTENT_GROUNDING_OPTIONS,
): IntentGrounding {
  const { byFile, symbolsByFile, weight } = anchorIndexFor(index);
  const lemmas = intentTerms(text).strong;
  const vocabulary = new Set(
    [...lemmas].filter((lemma) => weight.has(lemma)),
  );

  const notes: string[] = [];
  const targets: IntentTarget[] = [];
  const asked = mass(vocabulary, weight);
  for (const [file, anchors] of byFile) {
    const matched = [...vocabulary].filter((word) => anchors.has(word));
    if (matched.length === 0 || asked <= 0) {
      continue;
    }
    const score = mass(matched, weight) / asked;
    if (score >= options.targetFloor) {
      const reached = matched.length === 0 ? [] : [...(symbolsByFile.get(file) ?? new Map())]
        .filter(([, words]) => matched.some((word) => words.has(word)))
        .map(([symbol]) => symbol)
        .sort();
      targets.push({ file, score, anchors: matched.sort(), symbols: reached });
    }
  }
  targets.sort(
    (left, right) =>
      right.score - left.score || left.file.localeCompare(right.file),
  );
  const kept = targets.slice(0, MAX_TARGETS);

  if (vocabulary.size === 0) {
    notes.push(
      "intent shares no vocabulary with the repository; grounding has no opinion",
    );
  } else if (kept.length === 0) {
    notes.push(
      `intent names ${[...vocabulary].sort().join(", ")} but no file answers to ` +
        `enough of it to clear ${options.targetFloor}`,
    );
  }
  if (index.truncated && kept.length === 0) {
    // Same benefit of the doubt plan grounding gives: the file this intent is
    // really about may be one of the ones the byte budget skipped.
    notes.push(
      "index was truncated; the intended module may not have been indexed",
    );
  }

  return {
    revision: index.revision,
    targets: kept,
    vocabulary: [...vocabulary].sort(),
    confidence: kept.length > 0 ? "grounded" : "ungrounded",
    notes,
  };
}

/**
 * How two grounded intents are related, in descending order of strength.
 *
 * `shared` — both sentences point at the same file. Whatever they each meant
 * to do, they meant to do it to the same code.
 *
 * `calls` — a function one intent reaches calls a function the other reaches.
 * This is the cross-module relation, and it is stated about declarations
 * rather than files: `orderTotal -> discountRate` is a fact about two
 * functions, where "total.js imports discount.js" is a fact about two
 * neighbourhoods.
 *
 * `adjacent` — one's target imports the other's, with no call between the
 * symbols either one names. Retained below `calls` as the weakest tier, for
 * the case where the index parsed a file but the connection runs through
 * something other than a call expression.
 */
export type IntentRelation = "shared" | "calls" | "adjacent";

export interface GroundedIntentConflict {
  fires: boolean;
  /** Confidence in [0, 1], reported so a caller can weigh it. */
  score: number;
  relation?: IntentRelation;
  /** Files both intents ground to. */
  sharedTargets: string[];
  /** Call edges between the symbols the two intents reach. */
  callTargets: string[];
  /** Import edges between the two groundings, as `importer -> imported`. */
  adjacentTargets: string[];
  /** Lemmas both intents used, or that WordNet links as synonyms. */
  corroboration: string[];
  /** A WordNet antonym pair across the two intents, if any. */
  opposition?: [string, string];
  explanation: string;
}

export interface GroundedIntentOptions {
  /** Score for two intents grounded to the same file. */
  sharedWeight: number;
  /** Score when a function one intent reaches calls a function the other reaches. */
  callWeight: number;
  /** Score for two intents grounded to files one of which imports the other. */
  adjacentWeight: number;
  /** Added when WordNet records the two intents taking opposite directions. */
  oppositionBonus: number;
  /** Score at or above which the signal is reported as firing. */
  fireThreshold: number;
  lexicon?: WordNet | undefined;
}

/**
 * The operating point.
 *
 * These are strengths, not a classifier boundary — the one decision this
 * signal makes is `targetFloor`, and it is made in
 * {@link DEFAULT_INTENT_GROUNDING_OPTIONS}. `fireThreshold` sits below both
 * relation weights so that the two relations are the two ways to fire, and is
 * kept as a parameter only so a caller can ask for shared-target evidence
 * alone by raising it above `adjacentWeight`.
 */
export const DEFAULT_GROUNDED_INTENT_OPTIONS: GroundedIntentOptions = {
  sharedWeight: 0.8,
  callWeight: 0.65,
  adjacentWeight: 0.55,
  oppositionBonus: 0.1,
  fireThreshold: 0.5,
};

function sharedVocabulary(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  lexicon: WordNet | undefined,
): string[] {
  const shared = new Set<string>();
  for (const term of left) {
    if (right.has(term)) {
      shared.add(term);
    }
  }
  if (lexicon !== undefined) {
    for (const term of left) {
      if (right.has(term)) {
        continue;
      }
      for (const synonym of lexicon.synonyms(term)) {
        if (right.has(synonym)) {
          shared.add(`${term}/${synonym}`);
        }
      }
    }
  }
  return [...shared].sort();
}

function opposedPair(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  lexicon: WordNet | undefined,
): [string, string] | undefined {
  if (lexicon === undefined) {
    return undefined;
  }
  for (const term of [...left].sort()) {
    for (const antonym of lexicon.antonyms(term)) {
      if (right.has(antonym)) {
        return [term, antonym];
      }
    }
  }
  return undefined;
}

/** Import edges between two sets of files, in either direction. */
function importEdges(
  index: RepositoryIndex,
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const edge of index.edges) {
    if (edge.kind !== "import" || edge.toFile === undefined) {
      continue;
    }
    const forward = left.has(edge.fromFile) && right.has(edge.toFile);
    const backward = right.has(edge.fromFile) && left.has(edge.toFile);
    if (forward || backward) {
      found.add(`${edge.fromFile} -> ${edge.toFile}`);
    }
  }
  return [...found].sort();
}

/** Which files declare each symbol name, for resolving a call to its target. */
function declaringFiles(index: RepositoryIndex): Map<string, Set<string>> {
  const declaring = new Map<string, Set<string>>();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      const entry = declaring.get(symbol) ?? new Set<string>();
      entry.add(file.path);
      declaring.set(symbol, entry);
    }
  }
  return declaring;
}

/** One side of a pair, as the set of `file#symbol` its grounding reaches. */
function reachedSymbols(grounding: IntentGrounding): Set<string> {
  const reached = new Set<string>();
  for (const target of grounding.targets) {
    for (const symbol of target.symbols) {
      reached.add(`${target.file}#${symbol}`);
    }
  }
  return reached;
}

/**
 * Call edges between the symbols two intents reach, in either direction.
 *
 * Strictly narrower than {@link importEdges}: a file may import another
 * without the two *functions* in question having anything to do with each
 * other. `orderTotal -> discountRate` is a fact about two declarations, and
 * two tasks connected only by their files being neighbours do not produce one.
 *
 * A call is resolved to the file declaring the callee's name. Where a name is
 * declared in more than one file every declaration is admitted, because the
 * index carries no binding information and guessing one would be a claim it
 * cannot support.
 */
function callEdges(
  index: RepositoryIndex,
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): string[] {
  const declaring = declaringFiles(index);
  const found = new Set<string>();
  for (const file of index.files) {
    for (const call of file.symbolCalls) {
      const from = `${file.path}#${call.from}`;
      for (const target of declaring.get(call.to) ?? []) {
        const to = `${target}#${call.to}`;
        if (
          (left.has(from) && right.has(to)) ||
          (right.has(from) && left.has(to))
        ) {
          found.add(`${from} -> ${to}`);
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Whether two tasks' stated intents concern code that cannot be changed
 * independently, judged on where the repository says each one points.
 *
 * The structure is the same conjunction the text-only signal used, with the
 * two halves swapped for what each is good at. Grounding is the evidence: it
 * is the half that knows about modules, and it is what decides whether there
 * is anything to report. Lexical corroboration — a shared content lemma, or
 * two lemmas WordNet puts in one synset — is the veto: it is the half a human
 * can read in an audit trail, and it stops a coincidence of vocabulary in the
 * index from firing on two sentences with nothing to do with each other.
 * Opposition is a bonus on top, not a requirement: the intents that collide
 * hardest in practice both say "add".
 */
export function assessGroundedIntent(
  first: { text: string; grounding: IntentGrounding },
  second: { text: string; grounding: IntentGrounding },
  index: RepositoryIndex,
  options: GroundedIntentOptions = DEFAULT_GROUNDED_INTENT_OPTIONS,
): GroundedIntentConflict {
  const lexicon = options.lexicon ?? defaultLexicon();
  const left = intentTerms(first.text);
  const right = intentTerms(second.text);
  const corroboration = sharedVocabulary(left.strong, right.strong, lexicon);
  const opposition = opposedPair(left.lemmas, right.lemmas, lexicon);

  const leftFiles = new Set(first.grounding.targets.map((entry) => entry.file));
  const rightFiles = new Set(second.grounding.targets.map((entry) => entry.file));
  const sharedTargets = [...leftFiles]
    .filter((file) => rightFiles.has(file))
    .sort();
  const callTargets =
    sharedTargets.length > 0
      ? []
      : callEdges(
          index,
          reachedSymbols(first.grounding),
          reachedSymbols(second.grounding),
        );
  const adjacentTargets =
    sharedTargets.length > 0 || callTargets.length > 0
      ? []
      : importEdges(index, leftFiles, rightFiles);

  let relation: IntentRelation | undefined;
  let score = 0;
  if (corroboration.length > 0) {
    if (sharedTargets.length > 0) {
      relation = "shared";
      score = options.sharedWeight;
    } else if (callTargets.length > 0) {
      relation = "calls";
      score = options.callWeight;
    } else if (adjacentTargets.length > 0) {
      relation = "adjacent";
      score = options.adjacentWeight;
    }
    if (score > 0 && opposition !== undefined) {
      score = Math.min(1, score + options.oppositionBonus);
    }
  }

  const parts: string[] = [];
  if (relation === "shared") {
    parts.push(`both intents ground to ${sharedTargets.join(", ")}`);
  } else if (relation === "calls") {
    parts.push(`grounded symbols are linked by ${callTargets.join(", ")}`);
  } else if (relation === "adjacent") {
    parts.push(`grounded targets are linked by ${adjacentTargets.join(", ")}`);
  } else if (leftFiles.size === 0 || rightFiles.size === 0) {
    parts.push("at least one intent grounds to no file");
  } else {
    parts.push("grounded targets are unrelated in the import graph");
  }
  parts.push(
    corroboration.length > 0
      ? `shared intent terms: ${corroboration.join(", ")}`
      : "no shared intent term",
  );
  if (opposition !== undefined) {
    parts.push(`opposing terms (${opposition[0]}/${opposition[1]})`);
  }

  return {
    fires: score >= options.fireThreshold && score > 0,
    score,
    ...(relation === undefined ? {} : { relation }),
    sharedTargets,
    callTargets,
    adjacentTargets,
    corroboration,
    ...(opposition === undefined ? {} : { opposition }),
    explanation: parts.join("; "),
  };
}

/**
 * One pair's verdict, in the shape arbitration records evidence in.
 *
 * Deliberately structural rather than an import from the coordinator: this
 * package knows about repositories, not about scheduling, and inverting that
 * dependency to share a type would be the wrong trade.
 */
export interface IntentConflictVerdict {
  /** Confidence in [0, 1]. Arbitration scales its own weight by this. */
  probability: number;
  /** What the two plans were judged to share, for the audit trail. */
  resources: string[];
  explanation: string;
}

/**
 * Kill switch, and the control arm for the run that has not happened yet.
 *
 * `COORD_DISABLE_INTENT_GROUNDING=1` returns arbitration to the state in which
 * no grounded intent evidence is produced at all. This exists because the
 * signal is wired in **ahead of** the validation that would justify it — see
 * `docs/benchmarks/intent-grounding-wired.md` — and something switched on
 * before it is proven needs a way back off that does not require a deploy.
 */
function groundingDisabled(): boolean {
  return process.env["COORD_DISABLE_INTENT_GROUNDING"] === "1";
}

/**
 * An intent-conflict assessor bound to one repository index.
 *
 * Arbitration compares every admitted plan against every active one, so the
 * same intent sentence is grounded many times per decision. Groundings are
 * cached per text for the life of the assessor, which makes the cost linear in
 * distinct plans rather than quadratic in the queue.
 *
 * The verdict is **advisory and must stay advisory**. On the measurement in
 * `docs/benchmarks/intent-grounding.md` this signal is right about 70% of the
 * times it fires, against a bar of 80% that it did not clear, and the oracle
 * ceiling for its whole class of rule on that corpus is 75%. Evidence that
 * wrong three times in ten has no business sequencing anybody's work, and
 * `ConflictDetector.assess` is what enforces that: advisory evidence is scored
 * and recorded but excluded from the subtotal the disposition thresholds read.
 * If that guard is ever removed, this signal must come out with it.
 */
export function groundedIntentAssessor(
  index: RepositoryIndex,
  groundingOptions: IntentGroundingOptions = DEFAULT_INTENT_GROUNDING_OPTIONS,
  signalOptions: GroundedIntentOptions = DEFAULT_GROUNDED_INTENT_OPTIONS,
): (first: { intent?: string; objective: string }, second: { intent?: string; objective: string }) => IntentConflictVerdict | undefined {
  const cache = new Map<string, IntentGrounding>();
  const groundingFor = (text: string): IntentGrounding => {
    const cached = cache.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const grounding = groundIntent(text, index, groundingOptions);
    cache.set(text, grounding);
    return grounding;
  };

  return (first, second) => {
    if (groundingDisabled()) {
      return undefined;
    }
    const leftText = first.intent ?? first.objective;
    const rightText = second.intent ?? second.objective;
    if (leftText === undefined || rightText === undefined) {
      return undefined;
    }
    const result = assessGroundedIntent(
      { text: leftText, grounding: groundingFor(leftText) },
      { text: rightText, grounding: groundingFor(rightText) },
      index,
      signalOptions,
    );
    if (!result.fires) {
      return undefined;
    }
    const resources = [
      ...result.sharedTargets,
      ...result.callTargets,
      ...result.adjacentTargets,
    ];
    return {
      probability: result.score,
      resources,
      explanation: `${result.explanation} (grounded at ${index.revision}; advisory — this signal is unvalidated, see docs/benchmarks/intent-grounding-wired.md)`,
    };
  };
}

let lexicon: WordNet | undefined | null;

/** The shared WordNet handle, or nothing when the database is not installed. */
function defaultLexicon(): WordNet | undefined {
  if (lexicon === undefined) {
    const candidate = wordNet();
    lexicon = candidate.available() ? candidate : null;
  }
  return lexicon ?? undefined;
}
