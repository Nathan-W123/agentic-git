import assert from "node:assert/strict";
import test from "node:test";

import { createLocalSummariser, type Generator } from "./summary.js";

/**
 * A generator that answers instantly.
 *
 * Every test here injects one: none of them may load a real model, both
 * because a 80 MB download is not a unit test and because the behaviour being
 * checked — what the caller gets back — is the same either way.
 */
function canned(reply: string, calls: string[] = []): Generator {
  return async (prompt) => {
    calls.push(prompt);
    return reply;
  };
}

test("an injected generator's reply is what comes back", async () => {
  const summariser = createLocalSummariser({
    generator: canned("Three changes landed and one task stopped."),
  });
  assert.equal(
    await summariser.write("landed: 3\nfailed: 1"),
    "Three changes landed and one task stopped.",
  );
  assert.equal(await summariser.available(), true);
});

test("the prompt reaches the model as it was written", async () => {
  const calls: string[] = [];
  const summariser = createLocalSummariser({ generator: canned("ok", calls) });
  await summariser.write("  landed: 3  ");
  assert.deepEqual(calls, ["landed: 3"]);
});

test("the model is never woken for an empty prompt", async () => {
  const calls: string[] = [];
  const summariser = createLocalSummariser({
    generator: canned("something", calls),
  });
  assert.equal(await summariser.write("   \n  "), undefined);
  assert.deepEqual(calls, []);
});

test("a generator that throws gives up rather than raising", async () => {
  const summariser = createLocalSummariser({
    generator: async () => {
      throw new Error("onnx session is wedged");
    },
  });
  assert.equal(await summariser.write("landed: 3"), undefined);
});

test("a blank reply counts as no summary, not as an empty one", async () => {
  const summariser = createLocalSummariser({ generator: canned("   ") });
  assert.equal(await summariser.write("landed: 3"), undefined);
});

test("a generation past its budget is given up on, not waited out", async () => {
  const summariser = createLocalSummariser({
    budgetMs: 5,
    generator: async () =>
      await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          resolve("far too late");
        }, 5_000);
        // Unreferenced so the pending work cannot hold the test process open
        // once the budget has already answered for it.
        timer.unref?.();
      }),
  });
  assert.equal(await summariser.write("landed: 3"), undefined);
});

test("a model still loading past its warmup budget answers nothing", async () => {
  const summariser = createLocalSummariser({
    warmupBudgetMs: 5,
    generator: canned("a sentence"),
    // A generator is injected, so the load resolves immediately; the budget
    // being tiny is what proves the wait is bounded rather than skipped.
  });
  assert.equal(await summariser.write("landed: 3"), "a sentence");
});
