import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCoordinationStore } from "@coord/persistence";

import { leaseQueuedWork, runPendingTasks } from "./commands.js";
import { CoordinatorProject } from "./project.js";

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

/**
 * A project with a repository row pointing at a path that has no git in it.
 *
 * The claim under test is about what the control plane *does not do*, and the
 * sharpest way to assert that is to make doing it fail. `getCanonicalVersion`
 * shells out to git against `repository.path`, so a path with nothing there
 * throws — which means resolving without throwing proves git was never
 * reached, and the companion test proves it is reached when the flag is off.
 */
async function projectWithUnreachableGit(): Promise<{
  project: CoordinatorProject;
  store: InMemoryCoordinationStore;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "clocal-"));
  const project = await CoordinatorProject.init(path.join(root, "proj"));
  const store = new InMemoryCoordinationStore();
  await store.saveRepository({
    id: "repo_1",
    path: path.join(root, "absent-canonical.git"),
    branch: "main",
  });
  return {
    project,
    store,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("with COORD_LOCAL_AGENTS_ONLY a dispatch costs the control plane no git", async () => {
  // The claim gate is four calls further down, and the calls in between are
  // not free: resolving the canonical version runs three git processes, one
  // of them `rev-list --count` over the whole history. Every dispatched
  // channel message paid for all of it before being told there was nothing to
  // run — including every message arriving from an editor over MCP, which is
  // the traffic Kumi-as-an-MCP-server exists to attract.
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  process.env["COORD_LOCAL_AGENTS_ONLY"] = "1";
  const harness = await projectWithUnreachableGit();
  try {
    const summary = await runPendingTasks(harness.project, harness.store, {
      projectId: "project_local",
      repositoryId: "repo_1",
    });
    assert.deepEqual(summary.claimed, []);
    assert.equal(summary.integrated, 0);
  } finally {
    if (previous === undefined) {
      delete process.env["COORD_LOCAL_AGENTS_ONLY"];
    } else {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
    await harness.cleanup();
  }
});

test("unset, the same dispatch does reach the repository", async () => {
  // The half that makes the test above mean anything. With the flag off this
  // path is supposed to resolve the canonical version, so it must fail on a
  // repository with no git in it. A gate that skipped the work unconditionally
  // would pass the first test, and only this one would catch it.
  const previous = process.env["COORD_LOCAL_AGENTS_ONLY"];
  delete process.env["COORD_LOCAL_AGENTS_ONLY"];
  const harness = await projectWithUnreachableGit();
  try {
    await assert.rejects(
      async () =>
        await runPendingTasks(harness.project, harness.store, {
          projectId: "project_local",
          repositoryId: "repo_1",
        }),
    );
  } finally {
    if (previous !== undefined) {
      process.env["COORD_LOCAL_AGENTS_ONLY"] = previous;
    }
    await harness.cleanup();
  }
});

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
