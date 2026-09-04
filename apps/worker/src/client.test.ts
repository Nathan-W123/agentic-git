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

test("an image is sent as its own bytes, under its own content type", async () => {
  let seen: { url: string; contentType: string | null; body: unknown } | undefined;
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async (input, init) => {
      seen = {
        url: String(input),
        contentType: new Headers(init?.headers).get("Content-Type"),
        body: init?.body,
      };
      return new Response(JSON.stringify({ id: "abc.png" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(await client.attachImage("lease_1", bytes, "image/png"), "abc.png");
  assert.equal(
    seen?.url,
    "https://control.example/api/v1/workers/leases/lease_1/attachment",
  );
  // Not JSON: the store reads the format out of the bytes themselves, and
  // base64 in a field would have made them something else on the way.
  assert.equal(seen?.contentType, "image/png");
  assert.deepEqual([...(seen?.body as Uint8Array)], [...bytes]);
});

test("a refused image is undefined rather than a failed run", async () => {
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async () =>
      new Response(
        JSON.stringify({ error: { code: "not_supported", message: "no store" } }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      ),
  });
  assert.equal(
    await client.attachImage("lease_1", Buffer.from([1]), "image/png"),
    undefined,
  );
});
