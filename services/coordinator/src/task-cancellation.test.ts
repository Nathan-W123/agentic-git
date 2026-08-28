import assert from "node:assert/strict";
import test from "node:test";

import { TaskCancellationRegistry } from "./task-cancellation.js";

test("a cancel with nothing live still records, and says nothing ran", async () => {
  const registry = new TaskCancellationRegistry();
  assert.equal(await registry.cancel("task_a", "stopped"), false);
  // The reason is the part a later checkpoint reads — a cancel that lands
  // before the run registers its session must still be honoured.
  assert.equal(registry.reasonFor("task_a"), "stopped");
});

test("release drops the live abort but never the reason", async () => {
  const registry = new TaskCancellationRegistry();
  let aborts = 0;
  registry.register("task_a", async () => {
    aborts += 1;
  });
  assert.equal(await registry.cancel("task_a", "stopped"), true);
  assert.equal(aborts, 1);

  registry.release("task_a");
  // The session is gone, so nothing runs — but the ending is still on
  // record for the teardown paths that name it after the fact.
  assert.equal(await registry.cancel("task_a", "stopped again"), false);
  assert.equal(aborts, 1);
  assert.equal(registry.reasonFor("task_a"), "stopped again");
});

test("an abort that throws does not fail the cancel", async () => {
  const registry = new TaskCancellationRegistry();
  registry.register("task_a", async () => {
    throw new Error("session already gone");
  });
  assert.equal(await registry.cancel("task_a", "stopped"), true);
  assert.equal(registry.reasonFor("task_a"), "stopped");
});

test("a pause is a stop that the run's checkpoints can tell apart", async () => {
  const registry = new TaskCancellationRegistry();
  const aborted: string[] = [];
  registry.register("task_a", async (reason) => {
    aborted.push(reason);
  });

  // Same mechanics as a cancel: the live session is reached and aborted with
  // the pauser's own words, which is what stops the agent at all.
  assert.equal(await registry.pause("task_a", "paused from the thread"), true);
  assert.deepEqual(aborted, ["paused from the thread"]);
  assert.equal(registry.reasonFor("task_a"), "paused from the thread");
  // And the one thing that differs: the checkpoint that has to choose between
  // tearing the workspace down and keeping it can ask which stop this was.
  assert.equal(registry.intentFor("task_a"), "pause");

  // A pause that lands before the run registers its session is recorded the
  // same way, so it is still honoured at the next checkpoint.
  assert.equal(await registry.pause("task_b", "parked"), false);
  assert.equal(registry.intentFor("task_b"), "pause");
});

test("a cancel is still a cancel, and the newest stop is the one that counts", async () => {
  const registry = new TaskCancellationRegistry();
  await registry.cancel("task_a", "stopped");
  // Unstated intent would be indistinguishable from a pause at the
  // checkpoint, which is the one place the difference costs a workspace.
  assert.equal(registry.intentFor("task_a"), "cancel");
  assert.equal(registry.intentFor("task_never_stopped"), undefined);

  // Somebody who pauses and then changes their mind gets what they asked for
  // second, not a pause that quietly outranks the cancel behind it.
  await registry.pause("task_b", "paused");
  await registry.cancel("task_b", "actually, stop");
  assert.equal(registry.intentFor("task_b"), "cancel");
  assert.equal(registry.reasonFor("task_b"), "actually, stop");
});
