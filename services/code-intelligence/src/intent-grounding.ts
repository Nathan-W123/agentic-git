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
function anchorIndex(index: RepositoryIndex): AnchorIndex {
  const byFile = new Map<string, Set<string>>();
  for (const file of index.files) {
    if (TEST_PATH.test(file.path)) {
      continue;
    }
    byFile.set(file.path, fileAnchors(file));
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
  return { byFile, weight };
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
  const { byFile, weight } = anchorIndex(index);
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
      targets.push({ file, score, anchors: matched.sort() });
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
 * `adjacent` — one's target imports the other's. Weaker, and included for one
 * specific reason: the failure being fixed is a class of pair that *cannot*
 * share a file, where one task rewrites a caller and the other rewrites
 * something the caller reads. Identity alone is silent on every such pair by
 * construction, which is a guaranteed nil return on exactly the population the
 * previous negative result stumbled on.
 */
export type IntentRelation = "shared" | "adjacent";

export interface GroundedIntentConflict {
  fires: boolean;
  /** Confidence in [0, 1], reported so a caller can weigh it. */
  score: number;
  relation?: IntentRelation;
  /** Files both intents ground to. */
  sharedTargets: string[];
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
  const adjacentTargets =
    sharedTargets.length > 0 ? [] : importEdges(index, leftFiles, rightFiles);

  let relation: IntentRelation | undefined;
  let score = 0;
  if (corroboration.length > 0) {
    if (sharedTargets.length > 0) {
      relation = "shared";
      score = options.sharedWeight;
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
    adjacentTargets,
    corroboration,
    ...(opposition === undefined ? {} : { opposition }),
    explanation: parts.join("; "),
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
