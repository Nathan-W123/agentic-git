import assert from "node:assert/strict";
import test from "node:test";

import type { CoordinatorProject } from "@coord/cli/project";

import type { WorkerClient } from "./client.js";
import { Worker } from "./worker.js";

/**
 * The lease call is the assertion.
 *
 * A worker that declines work on battery has to decline it *before* asking for
 * any — a lease it takes and then cannot finish is held for the full
 * five-minute expiry, which is the failure this exists to avoid. So the test
 * is not "did it return early", it is "did the control plane ever hear from
 * it".
 */
function stubClient(calls: string[]): WorkerClient {
  return {
    register: async () => {
      calls.push("register");
      return { id: "worker_1" };
    },
    lease: async () => {
      calls.push("lease");
      return undefined;
    },
  } as unknown as WorkerClient;
}

const project = {
  config: { agents: { codex: { adapter: "codex" } } },
} as unknown as CoordinatorProject;

function makeWorker(
  calls: string[],
  state: "ac" | "battery" | "unknown",
  pauseOnBattery = false,
) {
  return new Worker({
    client: stubClient(calls),
    project,
    organizationId: "org_test",
    workspaceRoot: "/tmp/worker-power-test",
    powerSource: { read: async () => state },
    pauseOnBattery,
  });
}

test("a worker on battery asks for work like any other", async () => {
  // This used to be the opposite, and the caution cost far more than it
  // saved. Not asking is also not telling the control plane this machine
  // exists — liveness is a side effect of the lease request — so an unplugged
  // laptop did not read as a machine that was waiting. Three minutes later it
  // read as no machine at all, its owner's agents went grey, and the app
  // offered to install a CLI already on the disk, while somebody sat in front
  // of it perfectly able to work.
  const calls: string[] = [];
  await makeWorker(calls, "battery").runOnce();
  assert.ok(calls.includes("lease"), `expected a lease request, got: ${calls.join(", ")}`);
});

test("a machine that really does sleep unattended can still opt out", async () => {
  // The case the original caution was for: a lease held by a machine that
  // goes into standby is unavailable to everybody else until it expires.
  // Still worth having, now that it is a choice and says itself in the log.
  const calls: string[] = [];
  const result = await makeWorker(calls, "battery", true).runOnce();
  assert.equal(result.worked, false);
  assert.ok(
    !calls.includes("lease"),
    `expected no lease request, got: ${calls.join(", ")}`,
  );

  // Opting out is about battery, not about being cautious in general.
  const plugged: string[] = [];
  await makeWorker(plugged, "ac", true).runOnce();
  assert.ok(plugged.includes("lease"), `expected a lease request, got: ${plugged.join(", ")}`);
});

test("a worker on mains asks as usual", async () => {
  const calls: string[] = [];
  await makeWorker(calls, "ac").runOnce();
  assert.ok(calls.includes("lease"), `expected a lease request, got: ${calls.join(", ")}`);
});

test("a worker that cannot read its power source still asks", async () => {
  // The default has to be "work". A probe that fails on a server or in a
  // container would otherwise produce a worker that silently never claims.
  const calls: string[] = [];
  await makeWorker(calls, "unknown").runOnce();
  assert.ok(calls.includes("lease"), `expected a lease request, got: ${calls.join(", ")}`);
});
