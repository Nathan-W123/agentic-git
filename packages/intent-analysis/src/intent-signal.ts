import { cosineSimilarity } from "./embeddings.js";
import { intentTerms } from "./lemmas.js";
import { wordNet, type WordNet } from "./wordnet.js";

/**
 * Does the intent prose of two plans say they are after the same work?
 *
 * The shipped `intent_conflict` asked a much narrower question — do these two
 * sentences share a token *and* contain one of ten hardcoded opposite verbs —
 * and got the answer wrong every time it fired. Two things were wrong with it
 * beyond the size of the list. It compared raw tokens, so morphology defeated
 * it. And it treated opposition as the whole of the evidence, when what
 * decides whether two plans collide is whether they are about the same thing;
 * opposition is a modifier on that, not a substitute for it.
 *
 * So this is a conjunction of two independent readings, and it fires only when
 * both agree:
 *
 * - **Corroboration** — a lexical, explainable reason to think the two
 *   sentences name the same artefact: a shared content lemma, or two lemmas
 *   WordNet places in one synset. This is the half that can be shown to a
 *   human in an audit trail, and the half that stops a purely distributional
 *   score from firing on two sentences that merely sound alike.
 * - **Similarity** — the cosine between sentence embeddings, as a continuous
 *   score rather than a boolean. This is the half that discounts a shared
 *   lemma that happens to be incidental.
 *
 * Requiring both is a deliberate bias towards precision. The measurement this
 * replaces failed on false positives, not on misses, and an intent signal that
 * stays quiet costs nothing.
 */

export interface IntentSignalOptions {
  /** Cosine below which the pair scores zero however well corroborated. */
  similarityFloor: number;
  /** Cosine at which the similarity term saturates. */
  similarityCeiling: number;
  /** Added when WordNet records the two intents taking opposite directions. */
  oppositionBonus: number;
  /** Probability at or above which the signal is reported as firing. */
  fireThreshold: number;
  /**
   * Whether a shared lexical term is required.
   *
   * Kept as an option because "is corroboration load-bearing, or is the
   * embedding doing all the work" is a question the evaluation has to answer
   * rather than assume.
   */
  requireCorroboration: boolean;
  lexicon?: WordNet;
}

/**
 * The operating point, and how it was chosen.
 *
 * Only the development half of the registered split was consulted — the
 * `codex-a`, `codex-b` and `codex-c` tasks of the team-queue runs. On that
 * half the two classes separate completely: every designed conflict scores a
 * cosine of at least 0.26 and every non-conflict at most 0.24. A perfectly
 * separated sample does not locate a boundary, it only excludes one region,
 * and reading "0.25" off a gap of 0.02 in forty points would be fitting the
 * sample rather than the problem. That the development half separates so
 * easily is itself informative about its difficulty: its negatives are all
 * pricing against notifications or audit, which is not the distinction that
 * is hard.
 *
 * So the threshold is set a priori rather than read off the curve, and set
 * towards the precision end of the range the development data admits. The
 * effective cutoff is `similarityFloor + fireThreshold × (ceiling - floor)`
 * = 0.55: for this model family and sentence-length input, roughly where
 * cosine stops meaning "same domain" and starts meaning "the same object".
 * On the development half that gives 100% precision at 47% recall. Recall is
 * deliberately the thing being spent — the failure being fixed was false
 * positives, and a quiet signal costs nothing.
 *
 * These values were then frozen and the held-out half read once. See
 * `docs/benchmarks/intent-signal.md`.
 */
export const DEFAULT_INTENT_SIGNAL_OPTIONS: IntentSignalOptions = {
  similarityFloor: 0.35,
  similarityCeiling: 0.75,
  oppositionBonus: 0.15,
  fireThreshold: 0.5,
  requireCorroboration: true,
};

export interface IntentPair {
  text: string;
  /** Precomputed sentence embedding, if one was available when the plan came in. */
  embedding?: Float32Array | undefined;
}

export interface IntentSignalResult {
  /** Whether the signal claims these two plans are after the same work. */
  fires: boolean;
  /** Continuous confidence in [0, 1]. */
  probability: number;
  /** Cosine similarity, absent when no embedding was available. */
  similarity?: number;
  /** Lemmas both intents used, or that WordNet links as synonyms. */
  sharedTerms: string[];
  /** A WordNet antonym pair found across the two intents, if any. */
  opposition?: [string, string];
  explanation: string;
}

/**
 * Shared vocabulary between two intents, exact matches first and WordNet
 * synonym links second.
 *
 * A synonym link is reported as `left/right` so the audit trail says which two
 * different words were treated as one thing; "charge/fee" being the reason two
 * plans were flagged is a claim a reviewer can agree or disagree with, and
 * "charge" alone is not.
 */
function sharedVocabulary(
  left: Set<string>,
  right: Set<string>,
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
  left: Set<string>,
  right: Set<string>,
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function analyzeIntentPair(
  first: IntentPair,
  second: IntentPair,
  options: IntentSignalOptions = DEFAULT_INTENT_SIGNAL_OPTIONS,
): IntentSignalResult {
  const lexicon = options.lexicon ?? defaultLexicon();
  const left = intentTerms(first.text);
  const right = intentTerms(second.text);
  const shared = sharedVocabulary(left.strong, right.strong, lexicon);
  const opposition = opposedPair(left.lemmas, right.lemmas, lexicon);

  const similarity =
    first.embedding !== undefined && second.embedding !== undefined
      ? cosineSimilarity(first.embedding, second.embedding)
      : undefined;

  const corroborated = shared.length > 0;
  const gated = options.requireCorroboration && !corroborated;

  let probability = 0;
  if (!gated) {
    if (similarity === undefined) {
      // Without the model there is no continuous score to give, and a lexical
      // overlap on its own is what the previous signal was — measured at 50%
      // precision at best. It is reported, not scored.
      probability = 0;
    } else {
      const span = Math.max(
        1e-6,
        options.similarityCeiling - options.similarityFloor,
      );
      probability = clamp01((similarity - options.similarityFloor) / span);
      if (probability > 0 && opposition !== undefined) {
        probability = clamp01(probability + options.oppositionBonus);
      }
    }
  }

  const fires = probability >= options.fireThreshold && probability > 0;
  const parts: string[] = [];
  if (shared.length > 0) {
    parts.push(`shared intent terms: ${shared.join(", ")}`);
  } else {
    parts.push("no shared intent term");
  }
  if (similarity !== undefined) {
    parts.push(`intent similarity ${similarity.toFixed(2)}`);
  } else {
    parts.push("no embedding available");
  }
  if (opposition !== undefined) {
    parts.push(`opposing terms (${opposition[0]}/${opposition[1]})`);
  }

  return {
    fires,
    probability,
    ...(similarity === undefined ? {} : { similarity }),
    sharedTerms: shared,
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
