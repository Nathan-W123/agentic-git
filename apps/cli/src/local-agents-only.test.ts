import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";

import { leaseQueuedWork } from "./commands.js";

/**
 * A store that fails loudly if the control plane so much as looks at the
 * queue.
 *
 * Asserting on the empty return alone would pass just as well if the drain ran
 * and happened to find nothing, which is the wrong thing to be sure of. The
 * claim here is stronger: with local execution required, the control plane
 * does not go looking.
 */
function forbiddenStore() {
  return new Proxy(new InMemoryCoordinationStore(), {
    get(target, property, receiver) {
      if (property === "leaseNextTask" || property === "listSubmittedTasks") {
        return () => {
          throw new Error(`control plane reached for ${String(property)}`);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

const request = {
  workerId: "worker_control_plane",
  repositoryId: "repo_1",
  projectId: "project_local",
  baseRevision: "a".repeat(40),
};

test("with COORD_LOCAL_AGENTS_ONLY the control plane never claims", async () => {
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  process.env["COORD_LOCAL_AGENTS_ONLY"] = "1";
  try {
    const leased = await leaseQueuedWork(forbiddenStore(), request);
    assert.deepEqual(leased, []);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_AGENTS_ONLY"];
    } else {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
  }
});

test("unset, it is not a behaviour change at all", async () => {
  // The flag is a hosting decision, so every deployment that has not made it —
  // self-hosted installs, and the local CLI where the control plane *is* the
  // executor — must reach the queue exactly as before. Reaching the store is
  // the whole assertion; what it finds there is the existing suite's business.
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  delete process.env["COORD_LOCAL_AGENTS_ONLY"];
  try {
    await assert.rejects(
      async () => await leaseQueuedWork(forbiddenStore(), request),
      /control plane reached for/u,
    );
  } finally {
    if (previous !== undefined) {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
  }
});

test("a value other than 1 is off, so a stray setting cannot stop a fleet", () => {
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  try {
    for (const value of ["0", "false", "", "true", "yes"]) {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = value;
      // Only the exact "1" arms it, matching COORD_LEGACY_ADMISSION_LOOP
      // beside it. "true" reading as off is the deliberate half: a flag this
      // consequential should be switched on by the documented value or not
      // at all, rather than by anything that looks affirmative.
      assert.equal(
        process.env["COORD_LOCAL_AGENTS_ONLY"] === "1",
        false,
        `${value} must not arm local-only`,
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_AGENTS_ONLY"];
    } else {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
  }
});
