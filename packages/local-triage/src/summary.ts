/**
 * A local model that writes short prose, for the places a count is not enough.
 *
 * The chatter filter next door embeds sentences to compare them; it cannot
 * write one. This is the other half: a small instruction-following model,
 * run on CPU through ONNX, that turns a handful of facts into a sentence a
 * person can read at a glance.
 *
 * The same three rules the filter lives by apply here, for the same reasons:
 *
 * - Nothing here is ever the reason a request waits. Both the load and the
 *   generation are time-boxed, and both time out to `undefined`.
 * - `undefined` is the safe answer, and every failure produces it — a model
 *   that will not load, a platform ONNX has no binary for, a generation that
 *   throws, a reply that comes back blank. The caller is expected to have
 *   something deterministic to fall back to, and to use it.
 * - No text leaves the process. This is a local model, not a provider.
 *
 * What it is *not* is a source of truth. Callers should keep the facts they
 * fed in and treat the sentence as presentation, because a 77M-parameter
 * model paraphrasing six bullet points will occasionally paraphrase them
 * wrongly, and a wrong sentence next to the right list is a much smaller
 * problem than a wrong list.
 */

/** The model this runs on. Small, quantized, and CPU-only by design. */
export const DEFAULT_SUMMARY_MODEL = "Xenova/LaMini-Flan-T5-77M";

/**
 * How long a caller waits for a model that is still loading.
 *
 * Longer than the chatter filter's budget, because this runs on a page load
 * rather than on every message in a busy room, and a first visit that waits a
 * beat for a readable sentence is a better trade than one that never gets it.
 * Still bounded: the caller has deterministic text and will use it.
 */
export const DEFAULT_SUMMARY_WARMUP_BUDGET_MS = 2_000;

/** How long one generation may take before the caller gives up on it. */
export const DEFAULT_SUMMARY_BUDGET_MS = 5_000;

/** The subset of the transformers pipeline this needs, so tests can stand in. */
export type Generator = (
  prompt: string,
  maxNewTokens: number,
) => Promise<string>;

export interface LocalSummariser {
  /**
   * A short piece of prose for this prompt, or `undefined`.
   *
   * `undefined` is not an error — it means "no model wrote anything", which
   * is what a machine without the model, a wedged session, and a blank reply
   * all produce. Callers fall back rather than fail.
   */
  write(prompt: string, maxNewTokens?: number): Promise<string | undefined>;
  /** Whether the model is loaded and usable. For diagnostics and tests. */
  available(): Promise<boolean>;
}

export interface LocalSummariserOptions {
  /** Overrides the model. Anything that follows a short instruction will do. */
  model?: string;
  /** Injected generator, which is how the tests avoid loading a model at all. */
  generator?: Generator;
  /**
   * How long a caller waits for a model that is still loading. Anything but a
   * finite, positive number means "wait as long as it takes".
   */
  warmupBudgetMs?: number;
  /** How long one generation may take, same convention. */
  budgetMs?: number;
}

/**
 * The value, or `undefined` if it did not arrive inside the budget.
 *
 * The work is never cancelled, only stopped waiting on: a model half loaded
 * is worth finishing, and the next caller gets it ready. Racing also keeps a
 * later rejection handled, so a load that fails after its budget ran out does
 * not surface as an unhandled rejection.
 */
async function within<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<T | undefined> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return await work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, budgetMs);
        // Deliberately not `unref`'d. This timer is the only handle
        // holding the loop open while a budget runs, so unref'ing it means
        // that in a process with nothing else pending the loop empties, the
        // race never settles, and the awaiting caller is abandoned mid
        // decision — not "exits early", never resolves. Every budget here is
        // bounded (500ms to 5s) and `clearTimeout` below releases it the
        // moment the work wins, so the most this holds a process open for is
        // one decision somebody is already waiting on.
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Loads the text model, or reports that it could not be.
 *
 * The import is dynamic for the same reason the embedder's is: a deployment
 * that never summarises never pays to load it, and a build that lacks the
 * package — or a platform ONNX has no binary for — degrades to "no summary"
 * rather than refusing to start.
 */
async function loadGenerator(model: string): Promise<Generator | undefined> {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    // Loosely typed across the dynamic boundary on purpose: the generation
    // options this passes are the library's own, but pinning them to its
    // overloads would make a version bump a compile error in a code path
    // whose whole contract is "or nothing".
    const generate = (await pipeline("text2text-generation", model, {
      dtype: "q8",
    })) as unknown as (
      input: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    return async (prompt, maxNewTokens) => {
      const output = await generate(prompt, {
        max_new_tokens: maxNewTokens,
        // Greedy. A catch-up that reads differently on every refresh looks
        // broken, and there is nothing here worth being creative about.
        do_sample: false,
      });
      const first = Array.isArray(output) ? output[0] : output;
      const text = (first as { generated_text?: unknown } | undefined)
        ?.generated_text;
      return typeof text === "string" ? text : "";
    };
  } catch {
    return undefined;
  }
}

export function createLocalSummariser(
  options: LocalSummariserOptions = {},
): LocalSummariser {
  const model = options.model ?? DEFAULT_SUMMARY_MODEL;
  const warmupBudgetMs =
    options.warmupBudgetMs ?? DEFAULT_SUMMARY_WARMUP_BUDGET_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_SUMMARY_BUDGET_MS;
  // One load per process, shared by every caller. Started on the first
  // summary rather than at boot: a deployment nobody signs in to should not
  // pay a second of startup for a model it is not going to use.
  let loading: Promise<Generator | undefined> | undefined;

  const ready = async (): Promise<Generator | undefined> => {
    loading ??= options.generator !== undefined
      ? Promise.resolve(options.generator)
      : loadGenerator(model);
    return await loading;
  };

  return {
    // Diagnostics wait for the real answer: "can this deployment summarise at
    // all" is a different question from "can it summarise this right now",
    // and only the second one has somebody waiting on it.
    available: async () => (await ready()) !== undefined,
    write: async (prompt, maxNewTokens = 96) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) {
        // Nothing to summarise. Never worth waking a model for.
        return undefined;
      }
      // Starts the load if it has not started, but does not stand in the
      // caller's way while it runs.
      const generate = await within(ready(), warmupBudgetMs);
      if (generate === undefined) {
        return undefined;
      }
      try {
        const written = await within(
          generate(trimmed, maxNewTokens),
          budgetMs,
        );
        const text = written?.trim() ?? "";
        return text.length > 0 ? text : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
