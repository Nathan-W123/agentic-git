/**
 * Sentence embeddings for intent prose.
 *
 * The model is `all-MiniLM-L6-v2` — 6 layers, 384 dimensions, 22.7M
 * parameters, about 23MB quantized — run through `@xenova/transformers` on
 * onnxruntime. It is the smallest thing that gives a usable continuous
 * similarity between two English sentences, and small enough that a scheduler
 * can afford to embed a plan's intent once when the plan arrives.
 *
 * `@xenova/transformers` is **not** a declared dependency, and is imported
 * dynamically so that its absence is a runtime condition rather than a build
 * error. It drags onnxruntime, sharp and protobufjs behind it — about 260MB —
 * and the measurement in `docs/benchmarks/intent-signal.md` concluded that
 * nothing should schedule on this signal, so imposing that on every install
 * for code no service imports is not a trade worth making. To reproduce the
 * embedding measurements:
 *
 *   npm install --no-save @xenova/transformers
 *
 * Three constraints shape the interface:
 *
 * - **Optional.** The dependency is heavy and downloads weights on first use.
 *   Everything here degrades to "unavailable" rather than throwing, and the
 *   signal that consumes it is defined to work without it — `analyzeIntentPair`
 *   scores zero and says why, rather than guessing.
 * - **Asynchronous, but not on the scheduling path.** `ConflictDetector.assess`
 *   is synchronous and is called O(n²) times per wave. Embedding happens once
 *   per plan, ahead of arbitration; what arbitration sees is a vector already
 *   attached to the plan, and the comparison is a 384-term dot product.
 * - **Deterministic.** Same text, same vector, so a recorded run replays. The
 *   cache is keyed on the exact text for that reason as much as for speed.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export interface EmbedderOptions {
  /** Where model weights are cached; defaults to the library's own choice. */
  cacheDirectory?: string;
  /** Refuse to reach the network; only a already-cached model will load. */
  offline?: boolean;
}

/**
 * Cosine similarity of two unit-normalized vectors.
 *
 * The pipeline normalizes, so this is a dot product. It is written as its own
 * function anyway because the normalization is an assumption that belongs
 * somewhere a reader can find it.
 */
export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return Math.max(-1, Math.min(1, total));
}

export class IntentEmbedder {
  private readonly options: EmbedderOptions;

  private readonly cache = new Map<string, Float32Array>();

  private extractor: Extractor | undefined;

  private loading: Promise<Extractor | undefined> | undefined;

  private failure: string | undefined;

  public constructor(options: EmbedderOptions = {}) {
    this.options = options;
  }

  /** Why the embedder is unavailable, if it is. */
  public unavailableReason(): string | undefined {
    return this.failure;
  }

  private async load(): Promise<Extractor | undefined> {
    if (this.extractor !== undefined) {
      return this.extractor;
    }
    this.loading ??= (async () => {
      try {
        const module = await import("@xenova/transformers");
        if (this.options.cacheDirectory !== undefined) {
          module.env.cacheDir = this.options.cacheDirectory;
        }
        if (this.options.offline === true) {
          module.env.allowRemoteModels = false;
        }
        const pipeline = (await module.pipeline(
          "feature-extraction",
          EMBEDDING_MODEL,
          { quantized: true },
        )) as unknown as Extractor;
        this.extractor = pipeline;
        return pipeline;
      } catch (error) {
        this.failure =
          error instanceof Error ? error.message : "embedding model unavailable";
        return undefined;
      }
    })();
    return this.loading;
  }

  /** Whether the model loaded. Loads it if it has not been tried yet. */
  public async available(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  /**
   * Embed a batch of texts, returning `undefined` for the whole batch when the
   * model is unavailable.
   *
   * Batching matters: the per-call overhead dominates for sentence-length
   * input, so embedding ten plan intents together is roughly the cost of
   * embedding one.
   */
  public async embed(
    texts: readonly string[],
  ): Promise<Float32Array[] | undefined> {
    const extractor = await this.load();
    if (extractor === undefined) {
      return undefined;
    }
    const wanted = texts.filter((text) => !this.cache.has(text));
    const pending = [...new Set(wanted)];
    if (pending.length > 0) {
      const output = await extractor(pending, {
        pooling: "mean",
        normalize: true,
      });
      const width = output.dims[1] ?? EMBEDDING_DIMENSIONS;
      pending.forEach((text, index) => {
        this.cache.set(
          text,
          output.data.slice(index * width, (index + 1) * width),
        );
      });
    }
    return texts.map(
      (text) => this.cache.get(text) ?? new Float32Array(EMBEDDING_DIMENSIONS),
    );
  }
}
