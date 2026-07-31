import lemmatize from "wink-lemmatizer";

/**
 * Turning an intent sentence into the set of things it is about.
 *
 * The shipped signal compared raw lowercased tokens, which is why "order" and
 * "orders" were different words to it, and "charge" and "charges" too — the
 * two most common ways two pricing tasks refer to the same thing. Stemming
 * would fix the plurals and break other things ("pricing" → "pric"); a real
 * lemmatizer gives a word that is still a word, which matters because the
 * next stage looks the result up in WordNet.
 */

/**
 * Words carrying no information about *what* a task changes.
 *
 * This is longer than the twelve-word list the shipped signal used, and the
 * additions are not generic English stop words: they are the vocabulary that
 * every agent-written intent in this repository shares. "Existing",
 * "behavior", "preserve", "change", "add", "without" appear in almost every
 * intent, because the planning prompt asks for a statement of what changes and
 * what is preserved. Left in, they make every pair of intents look related,
 * which is precisely the failure mode being fixed.
 */
const STOP_WORDS = new Set([
  // Ordinary function words.
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "do",
  "does", "each", "either", "every", "for", "from", "has", "have", "in", "into",
  "is", "it", "its", "not", "of", "on", "only", "or", "other", "over", "per",
  "so", "than", "that", "the", "their", "them", "there", "these", "they",
  "this", "those", "to", "up", "was", "were", "what", "when", "where", "which",
  "while", "who", "will", "with", "within", "without",
  // Plan boilerplate: present in nearly every agent intent, so shared between
  // nearly every pair, so worthless as evidence that two plans collide.
  "add", "additional", "adjust", "allow", "apply", "behavior", "behaviour",
  "capture", "change", "coverage", "current", "currently", "ensure", "enable",
  "existing", "expand", "implement", "include", "introduce", "keep", "leave",
  "maintain", "make", "modify", "new", "preserve", "provide", "record",
  "regression", "remain", "retain", "return", "set", "support", "test",
  "tests", "update", "use", "value",
]);

/**
 * Terms too generic to corroborate anything even after lemmatization.
 *
 * Separate from the stop list because these *are* content words and belong in
 * the embedded sentence — they just cannot be the shared term that makes two
 * plans look like they collide.
 */
const WEAK_TERMS = new Set([
  "case", "data", "default", "detail", "feature", "field", "function", "item",
  "logic", "method", "module", "name", "number", "option", "output", "part",
  "path", "result", "rule", "state", "step", "thing", "time", "type", "way",
  "work",
]);

const WORD = /[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*/gu;

/**
 * The lemma of one token.
 *
 * Each of the three lemmatizers is tried and the shortest distinct result
 * wins. WordNet's morphology is per-part-of-speech and the intents here are
 * not POS-tagged, so trying all three and preferring the one that actually
 * reduced the word is a cheap stand-in: "charges" reduces as a noun,
 * "charging" as a verb, "higher" as an adjective, and a word that is already
 * a lemma survives all three unchanged.
 */
export function lemmaOf(token: string): string {
  const word = token.toLowerCase();
  const candidates = [
    lemmatize.noun(word),
    lemmatize.verb(word),
    lemmatize.adjective(word),
  ].filter((candidate) => candidate.length > 0);
  let best = word;
  for (const candidate of candidates) {
    if (candidate.length < best.length) {
      best = candidate;
    }
  }
  return best;
}

export interface IntentTerms {
  /** Content lemmas, stop words and boilerplate removed. */
  lemmas: Set<string>;
  /** The subset strong enough to corroborate a collision on its own. */
  strong: Set<string>;
}

/**
 * Split a hyphenated or underscored compound into its parts as well as
 * keeping the whole: agents write "order-total", "created-at" and
 * "IP-address", and both readings are useful.
 */
function expand(token: string): string[] {
  const parts = token.split(/[-_]/u).filter((part) => part.length > 0);
  return parts.length > 1 ? [token, ...parts] : [token];
}

export function intentTerms(text: string): IntentTerms {
  const lemmas = new Set<string>();
  const strong = new Set<string>();
  for (const match of text.toLowerCase().matchAll(WORD)) {
    for (const token of expand(match[0])) {
      if (token.length < 3 || STOP_WORDS.has(token)) {
        continue;
      }
      const lemma = lemmaOf(token);
      if (lemma.length < 3 || STOP_WORDS.has(lemma)) {
        continue;
      }
      lemmas.add(lemma);
      if (!WEAK_TERMS.has(lemma)) {
        strong.add(lemma);
      }
    }
  }
  return { lemmas, strong };
}
