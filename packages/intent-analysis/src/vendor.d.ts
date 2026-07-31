/**
 * Types for the dependencies this package uses without bundled declarations.
 *
 * `wink-lemmatizer` and `wordnet-db` ship plain CommonJS with no types, and
 * both have a surface small enough that a hand-written declaration is more
 * honest than a blanket `any`: the compiler still checks that we call them
 * correctly.
 *
 * `@xenova/transformers` is here for a different reason. It is deliberately
 * *not* installed — see `embeddings.ts` — so without a declaration the tree
 * does not compile at all, and with one it compiles whether or not anybody
 * has run the optional install. Only the two members `IntentEmbedder` touches
 * are declared, which also keeps the compiler honest about that boundary.
 */

declare module "wink-lemmatizer" {
  const lemmatize: {
    noun: (word: string) => string;
    verb: (word: string) => string;
    adjective: (word: string) => string;
  };
  export default lemmatize;
}

declare module "wordnet-db" {
  const database: {
    /** Absolute path to the WordNet `dict` directory. */
    path: string;
    version: string;
    files: string[];
  };
  export default database;
}

declare module "@xenova/transformers" {
  export const env: {
    cacheDir: string;
    allowRemoteModels: boolean;
  };
  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: { quantized?: boolean },
  ): Promise<unknown>;
}
