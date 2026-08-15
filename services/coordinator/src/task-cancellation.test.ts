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
