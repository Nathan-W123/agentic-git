import assert from "node:assert/strict";
import test from "node:test";

import { ControlPlaneError } from "./client.js";
import type { HostSignal } from "./host-signal.js";
import {
  REFUSED_RETRY_MS,
  isRefusal,
  refusedRetryMs,
  registerWhenAllowed,
} from "./registration.js";

test("a refused registration is waited out, not died of", async () => {
  // What used to happen: the 403 threw out of `main`, the process exited, and
  // the supervisor — which reads an immediate exit as "misconfigured" — gave
  // up after four tries with "the worker kept exiting immediately and was not
  // restarted". True, and no help to anybody. The thing that was actually
  // wrong could only be fixed by somebody else, somewhere else, and when they
  // fixed it nothing on the machine noticed.
  const signals: HostSignal[] = [];
  const waits: number[] = [];
  let attempts = 0;

  const id = await registerWhenAllowed(
    async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new ControlPlaneError(
          403,
          "forbidden",
          'The "Refused\'s Workspace" workspace is read-only.',
        );
      }
      return "worker-1";
    },
    {
      signal: (signal) => signals.push(signal),
      wait: async (ms) => {
        waits.push(ms);
      },
      report: () => {},
    },
  );

  assert.equal(id, "worker-1");
  assert.equal(attempts, 3, "it keeps asking until it is allowed");
  assert.deepEqual(
    waits,
    [REFUSED_RETRY_MS[0], REFUSED_RETRY_MS[1]],
    "and backs off between attempts rather than hammering",
  );
  assert.deepEqual(
    signals.map((signal) => signal.type),
    ["registration-refused", "registration-refused", "registered"],
    "the host hears every refusal, and hears when it is over",
  );
  const first = signals[0];
  assert.ok(first !== undefined && first.type === "registration-refused");
  assert.match(
    first.detail,
    /Refused's Workspace/u,
    "carrying the control plane's own sentence, which is the only text " +
      "anywhere that names what is wrong",
  );
});

test("everything that is not a refusal still throws", async () => {
  // The loop exists for the one failure a restart cannot fix. A broken
  // deployment, a wrong address and an unreachable host are all better served
  // by the supervisor's restart than by an hour of polite asking, and a
  // worker that swallowed them would be a worker that never reports them.
  for (const error of [
    new ControlPlaneError(404, "not_found", "no such route"),
    new ControlPlaneError(500, "internal_error", "it broke"),
    new Error("fetch failed"),
  ]) {
    await assert.rejects(
      registerWhenAllowed(
        () => Promise.reject(error),
        { signal: () => {}, wait: async () => {}, report: () => {} },
      ),
      (thrown: unknown) => thrown === error,
      `${String(error)} must not be waited out`,
    );
  }

  assert.equal(isRefusal(new ControlPlaneError(401, "unauthorized", "")), true);
  assert.equal(isRefusal(new ControlPlaneError(403, "forbidden", "")), true);
  assert.equal(isRefusal(new ControlPlaneError(429, "slow_down", "")), false);
  assert.equal(isRefusal(new Error("ECONNRESET")), false);
});

test("the wait grows and then holds, rather than growing forever", async () => {
  // A worker refused for an hour is still worth one attempt a minute. Reading
  // past the end of the table is the ordinary way that becomes one attempt a
  // day, or `undefined` milliseconds, which is zero.
  assert.equal(refusedRetryMs(0), REFUSED_RETRY_MS[0]);
  assert.equal(refusedRetryMs(REFUSED_RETRY_MS.length - 1), 60_000);
  assert.equal(refusedRetryMs(9_999), 60_000);
  assert.equal(refusedRetryMs(-1), REFUSED_RETRY_MS[0]);
});
