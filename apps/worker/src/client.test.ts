import assert from "node:assert/strict";
import test from "node:test";

import { WORKER_PROTOCOL_VERSION } from "@coord/cli/worker-operations";

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

/**
 * A lease request says which protocol this worker speaks.
 *
 * The control plane decides what to hand over on this request and nowhere
 * else, and a lease can now carry MCP servers that a build predating them
 * would silently run without. The version is what lets it withhold those
 * from a worker that could not honour them — so it has to be on this request,
 * as JSON, under the name the gateway reads.
 */
test("a lease request announces the worker's protocol version", async () => {
  const seen: { url: string; contentType: string | null; body: unknown }[] = [];
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        contentType: new Headers(init?.headers).get("content-type"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(undefined, { status: 204 });
    },
  });

  assert.equal(await client.lease("worker_1", "project_1"), undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://control.example/api/v1/workers/leases");
  assert.equal(seen[0]?.contentType, "application/json");
  assert.deepEqual(seen[0]?.body, {
    workerId: "worker_1",
    projectId: "project_1",
    protocolVersion: WORKER_PROTOCOL_VERSION,
  });
  assert.equal(typeof WORKER_PROTOCOL_VERSION, "number");
});
