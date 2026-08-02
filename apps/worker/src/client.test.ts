import assert from "node:assert/strict";
import test from "node:test";

import { WorkerClient } from "./client.js";

test("bundle limits are enforced while an unbounded response streams", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    maxBundleBytes: 4,
    fetch: async () => new Response(stream),
  });

  await assert.rejects(client.bundle("lease_1"), /exceeds 4 bytes/u);
  assert.equal(cancelled, true);
});

test("request timeouts remain active while the response body is read", async () => {
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    requestTimeoutMs: 20,
    fetch: async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(stream);
    },
  });

  const started = Date.now();
  await assert.rejects(client.bundle("lease_1"), /abort/iu);
  assert.ok(Date.now() - started < 2_000);
});
