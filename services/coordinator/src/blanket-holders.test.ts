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

test("a later contention episode asks again", async () => {
  // The bound is one ask at a time, not one ask ever. A holder joined, left
  // alone, and joined again has told nobody anything about the second
  // arrival, and the entry has to be gone for that to be askable.
  let asks = 0;
  const stop = registerBlanketHolder(
    holder("task_b", async () => {
      asks += 1;
      return { files: ["src/total.js"], symbols: ["orderTotal"] };
    }),
  );
  const session = blanketHolderSession("task_b" as TaskId);
  assert.ok(session);

  await askBlanketHolderOnce(session);
  await askBlanketHolderOnce(session);

  assert.equal(asks, 2);
  stop();
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
