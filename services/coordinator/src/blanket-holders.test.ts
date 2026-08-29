import assert from "node:assert/strict";
import test from "node:test";

import type { TaskDefinition, TaskId } from "@coord/shared-types";

import {
  askBlanketHolderOnce,
  blanketHolderSession,
  registerBlanketHolder,
  type BlanketHolderSession,
} from "./blanket-holders.js";

function holder(
  id: string,
  declare: BlanketHolderSession["declare"],
): BlanketHolderSession {
  return {
    task: { id: id as TaskId, objective: `objective ${id}` } as TaskDefinition,
    repositoryId: "repo_1",
    declare,
  };
}

/** Resolves when released, so a test can hold an ask open deliberately. */
function held(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("arrivals landing together share one ask rather than one each", async () => {
  // The bound used to live on the plan authority's `asked` set, and that was
  // only ever right by accident. An authority is built per run, so two
  // arrivals in one worker hold two different sets while this registry is one
  // module-level map. Driven sequentially it looked correct — the first
  // arrival converted the claim durably and the rest never reached the ask —
  // so the test that claimed the bound was really testing the conversion.
  //
  // Driven concurrently, which is what two runs in one worker do, it measured
  // three pauses and three replans against one live session. A vendor CLI
  // refuses a second process while one is live, so all three then failed and
  // every arrival was deferred: no wrong grant, but a lost round and three
  // agent invocations to buy it.
  let asks = 0;
  const gate = held();
  const stop = registerBlanketHolder(
    holder("task_a", async () => {
      asks += 1;
      await gate.promise;
      return { files: ["src/total.js"], symbols: ["orderTotal"] };
    }),
  );

  const session = blanketHolderSession("task_a" as TaskId, "repo_1");
  assert.ok(session);
  const arrivals = [
    askBlanketHolderOnce(session),
    askBlanketHolderOnce(session),
    askBlanketHolderOnce(session),
  ];
  gate.release();
  const answers = await Promise.all(arrivals);

  assert.equal(asks, 1, "the holder was paused more than once");
  // And everybody waiting gets the answer. Refusing the second and third
  // caller would also have bounded the ask, and would have been worse: they
  // wanted the declaration, not the asking.
  for (const answer of answers) {
    assert.deepEqual(answer?.symbols, ["orderTotal"]);
  }
  stop();
});

test("a holder that has answered is not paused to answer again", async () => {
  // This used to assert the opposite — one ask at a time, not one ask ever, on
  // the reasoning that a second arrival has been told nothing about itself.
  // That reasoning does not survive what the answer actually is. A holder is
  // asked what the rest of *its own* work needs; the reply is about the run,
  // not about whoever happened to arrive, so a second arrival re-asking gets
  // the same sentence back and pays a paused vendor session for it.
  //
  // It was also the more expensive half of a live failure. The ask is bounded
  // because a decision waits on it, and the bound is short next to a pause and
  // a model round trip, so in production the first arrival usually gives up
  // first. The answer then landed, was dropped on settle, and reached nobody —
  // and the next arrival started the whole thing again. Repeatedly pausing one
  // live session is precisely what this module was written to stop; doing it
  // across time rather than in parallel is the same harm.
  //
  // Reuse is the conservative direction as well as the cheap one: a
  // declaration made earlier describes more remaining work than one made
  // later, so an arrival decided against it is told the holder needs more, not
  // less.
  let asks = 0;
  const stop = registerBlanketHolder(
    holder("task_b", async () => {
      asks += 1;
      return { files: ["src/total.js"], symbols: ["orderTotal"] };
    }),
  );
  const session = blanketHolderSession("task_b" as TaskId);
  assert.ok(session);

  const first = await askBlanketHolderOnce(session);
  const second = await askBlanketHolderOnce(session);

  assert.equal(asks, 1, "the holder was paused again for an answer it had given");
  assert.deepEqual(second, first);
  stop();
});

test("a new run of the same task is asked afresh", async () => {
  // Where "not one ask ever" is actually true: the boundary is the holder's
  // execution, not the contention episode. A declaration is a statement about
  // the rest of one run's work and must not outlive it — deregistering clears
  // it along with any ask in flight.
  let asks = 0;
  const declare = async (): Promise<{ files: string[]; symbols: string[] }> => {
    asks += 1;
    return { files: ["src/total.js"], symbols: ["orderTotal"] };
  };
  const stop = registerBlanketHolder(holder("task_b2", declare));
  const first = blanketHolderSession("task_b2" as TaskId);
  assert.ok(first);
  await askBlanketHolderOnce(first);
  stop();

  const restarted = registerBlanketHolder(holder("task_b2", declare));
  const second = blanketHolderSession("task_b2" as TaskId);
  assert.ok(second);
  await askBlanketHolderOnce(second);

  assert.equal(asks, 2, "a fresh run reused the previous run's declaration");
  restarted();
});

test("a failing ask answers undefined for everyone waiting on it", async () => {
  // Every caller treats a failed ask as "fall back to the freeze". A shared
  // promise must not hand a rejection to a caller that never made the call,
  // and a throw here would surface as an unhandled rejection in whichever
  // arrival happened to be second.
  let asks = 0;
  const gate = held();
  const stop = registerBlanketHolder(
    holder("task_c", async () => {
      asks += 1;
      await gate.promise;
      throw new Error("the session stopped answering");
    }),
  );
  const session = blanketHolderSession("task_c" as TaskId);
  assert.ok(session);

  const both = [askBlanketHolderOnce(session), askBlanketHolderOnce(session)];
  gate.release();
  assert.deepEqual(await Promise.all(both), [undefined, undefined]);
  assert.equal(asks, 1);
  stop();
});

test("deregistering a holder leaves nothing to join", async () => {
  // A session on its way out must not be joinable: the promise is already
  // settling or abandoned, and a late joiner would be told about a holder
  // that no longer exists.
  const stop = registerBlanketHolder(
    holder("task_d", async () => ({
      files: ["src/total.js"],
      symbols: ["orderTotal"],
    })),
  );
  stop();
  assert.equal(blanketHolderSession("task_d" as TaskId), undefined);
});
