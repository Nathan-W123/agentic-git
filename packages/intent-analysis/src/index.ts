export {
  cosineSimilarity,
  IntentEmbedder,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbedderOptions,
} from "./embeddings.js";
export { intentTerms, lemmaOf, type IntentTerms } from "./lemmas.js";
export {
  analyzeIntentPair,
  DEFAULT_INTENT_SIGNAL_OPTIONS,
  type IntentPair,
  type IntentSignalOptions,
  type IntentSignalResult,
} from "./intent-signal.js";
export { WordNet, wordNet, type PartOfSpeech } from "./wordnet.js";
