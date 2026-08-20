import { CHATTER_PROTOTYPES, WORK_PROTOTYPES } from "./prototypes.js";

export { CHATTER_PROTOTYPES, WORK_PROTOTYPES } from "./prototypes.js";

/**
 * A local first pass over channel messages, so most of them never reach a
 * model somebody is paying for.
 *
 * Deciding what an unaddressed message is takes a real model — that is why
 * the word list was removed. But it runs on the agent owner's own
 * subscription, once per message, in a room where most messages are people
 * talking to each other. Paying a vendor to be told "hi Ethan" is not work is
 * the waste this removes.
 *
 * So this is a filter, not a decision. It answers exactly one question —
 * "is this confidently just conversation?" — and it is allowed to say yes
 * only when it is not close. Anything else, including everything it is
 * unsure about, goes on to the agent exactly as before. That asymmetry is
 * what makes it safe to run in front of the real decision: the worst it can
 * do when it is wrong is stay quiet about a message, which is what the whole
 * unaddressed path does by default and which a person fixes by @mentioning
 * somebody.
 *
 * The model is a 22 MB sentence-embedding model (MiniLM), run on CPU through
 * ONNX. A message is embedded once — about three milliseconds — and compared
 * with two small sets of example sentences. No text leaves the process.
 *
 * Nothing here is ever allowed to be the reason a message waits. Loading the
 * model is not three milliseconds — it is an import, a download the first
 * time, and an ONNX session — and every message that arrived during it used
 * to sit behind it, which made the first unaddressed message after a deploy
 * the slowest one the room would ever see. Both waits are now bounded and
 * both time out to the same safe answer the rest of this file fails to: the
 * message goes to the agent, the load carries on in the background, and the
 * next message finds it ready.
 */

/** How far onto the chatter side a message must fall to be dropped locally. */
export const DEFAULT_CHATTER_MARGIN = 0.2;

/**
 * How long a message will wait for a model that is still loading.
 *
 * Short on purpose. A message that gives up here is not mis-classified, it is
 * un-classified: it goes on to the agent, which is exactly what happens on a
 * deployment where the model never loads at all. Spending a person's wait on
 * a saving that is measured in cents is the wrong trade in a chat window.
 */
export const DEFAULT_WARMUP_BUDGET_MS = 500;

/**
 * How long one message's own embedding may take before it is handed on.
 *
 * The embedding is milliseconds when the process is healthy, so this is not a
 * tuning knob — it is a ceiling, so a wedged ONNX session degrades to "the
 * filter is not helping" rather than to a room that has stopped answering.
 */
export const DEFAULT_DECISION_BUDGET_MS = 2_000;

/** The model this runs on. Small, quantized, and CPU-only by design. */
export const DEFAULT_TRIAGE_MODEL = "Xenova/all-MiniLM-L6-v2";

export interface ChatterFilter {
  /**
   * Whether this message is confidently just conversation.
   *
   * False is the safe answer and the one every failure produces: a model
   * that will not load, a message it is unsure about, an embedding that
   * throws. False means "ask the agent", which is what happened before this
   * existed.
   */
  readsAsChatter(text: string): Promise<boolean>;
  /** Whether the model is loaded and usable. For diagnostics and tests. */
  available(): Promise<boolean>;
}

/** The subset of the transformers pipeline this needs, so tests can stand in. */
export type Embedder = (
  texts: readonly string[],
) => Promise<readonly (readonly number[])[]>;

export interface ChatterFilterOptions {
  /** Overrides the model. Anything that embeds sentences will do. */
  model?: string;
  /** Injected embedder, which is how the tests avoid loading a model at all. */
  embedder?: Embedder;
  /** How decisive the answer has to be. Higher keeps more messages. */
  margin?: number;
  /**
   * How long a message waits for a model that is still loading. Anything
   * but a finite, positive number means "wait as long as it takes".
   */
  warmupBudgetMs?: number;
  /** How long a message waits for its own embedding, same convention. */
  decisionBudgetMs?: number;
}

/**
 * The value, or `undefined` if it did not arrive inside the budget.
 *
 * The work is never cancelled, only stopped waiting on: a model half loaded
 * is worth finishing, and the message after this one gets it ready. Racing
 * also keeps a later rejection handled, so a load that fails after its budget
 * ran out does not surface as an unhandled rejection.
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
        // Never a reason to hold a process open for a triage decision.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

/** The closest of a set of prototypes, which is what "sounds like" means. */
function nearest(
  vector: readonly number[],
  prototypes: readonly (readonly number[])[],
): number {
  let best = -1;
  for (const prototype of prototypes) {
    const score = dot(vector, prototype);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

/**
 * Loads the embedding model, or reports that it could not be.
 *
 * The import is dynamic so a deployment that never uses this never pays to
 * load it, and so a build that lacks the package — or a platform ONNX has no
 * binary for — degrades to "everything goes to the agent" rather than
 * refusing to start. The control plane must boot on a machine this does not
 * work on.
 */
async function loadEmbedder(model: string): Promise<Embedder | undefined> {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const extract = await pipeline("feature-extraction", model, {
      dtype: "q8",
    });
    return async (texts) => {
      const output = await extract([...texts], {
        pooling: "mean",
        normalize: true,
      });
      return output.tolist() as number[][];
    };
  } catch {
    return undefined;
  }
}

export function createChatterFilter(
  options: ChatterFilterOptions = {},
): ChatterFilter {
  const margin = options.margin ?? DEFAULT_CHATTER_MARGIN;
  const model = options.model ?? DEFAULT_TRIAGE_MODEL;
  const warmupBudgetMs = options.warmupBudgetMs ?? DEFAULT_WARMUP_BUDGET_MS;
  const decisionBudgetMs =
    options.decisionBudgetMs ?? DEFAULT_DECISION_BUDGET_MS;
  // One load per process, shared by every channel. Started on the first
  // message rather than at boot: a deployment whose rooms are quiet should
  // not pay a second of startup for a model it is not going to use.
  let loading:
    | Promise<{ embedder: Embedder; chatter: number[][]; work: number[][] } | undefined>
    | undefined;

  const prepare = async (): Promise<
    { embedder: Embedder; chatter: number[][]; work: number[][] } | undefined
  > => {
    const embedder = options.embedder ?? (await loadEmbedder(model));
    if (embedder === undefined) {
      return undefined;
    }
    try {
      // Both sets in one pass, once. They never change while the process
      // runs, so this is the only embedding work that is not per message.
      const all = await embedder([...CHATTER_PROTOTYPES, ...WORK_PROTOTYPES]);
      return {
        embedder,
        chatter: all.slice(0, CHATTER_PROTOTYPES.length).map((v) => [...v]),
        work: all.slice(CHATTER_PROTOTYPES.length).map((v) => [...v]),
      };
    } catch {
      return undefined;
    }
  };

  const ready = async (): Promise<
    { embedder: Embedder; chatter: number[][]; work: number[][] } | undefined
  > => {
    loading ??= prepare();
    return await loading;
  };

  return {
    // Diagnostics wait for the real answer: "is this deployment able to
    // filter at all" is a different question from "can it filter this
    // message right now", and only the second one has somebody waiting on it.
    available: async () => (await ready()) !== undefined,
    readsAsChatter: async (text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return false;
      }
      // Starts the load if it has not started, but does not stand in the
      // message's way while it runs.
      const loaded = await within(ready(), warmupBudgetMs);
      if (loaded === undefined) {
        return false;
      }
      try {
        const embedded = await within(
          loaded.embedder([trimmed]),
          decisionBudgetMs,
        );
        const vector = embedded?.[0];
        if (vector === undefined) {
          return false;
        }
        const chatter = nearest(vector, loaded.chatter);
        const work = nearest(vector, loaded.work);
        // Strictly greater by the whole margin. A message that is merely
        // closer to chatter is not confidently chatter, and the agent is the
        // one qualified to say which.
        return chatter - work >= margin;
      } catch {
        return false;
      }
    },
  };
}
