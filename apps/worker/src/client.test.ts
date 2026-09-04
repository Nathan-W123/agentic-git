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

test("a non-JSON error page becomes a control-plane error that quotes it", async () => {
  // The failure this replaces killed a worker on somebody's laptop and left
  // nothing behind: JSON.parse ran before the status was read, so a proxy's
  // HTML page raised a SyntaxError, which is not retryable and not a
  // ControlPlaneError, and it exited the process out of `register`.
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
      }),
  });

  await assert.rejects(
    client.register({
      organizationId: "org_1",
      name: "laptop",
      adapters: ["codex"],
      version: "1.0.0",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ControlPlaneError");
      assert.match(error.message, /502 Bad Gateway/u);
      return true;
    },
  );
});

test("registration that carries no worker id is refused by name", async () => {
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async () => new Response(null, { status: 204 }),
  });

  await assert.rejects(
    client.register({
      organizationId: "org_1",
      name: "laptop",
      adapters: ["codex"],
      version: "1.0.0",
    }),
    /reply carried no worker id/u,
  );
});

test("a successful reply that is not JSON is reported, not returned", async () => {
  const client = new WorkerClient({
    serverUrl: "https://control.example",
    token: "token",
    fetch: async () => new Response("not json at all", { status: 200 }),
  });

  await assert.rejects(
    client.register({
      organizationId: "org_1",
      name: "laptop",
      adapters: ["codex"],
      version: "1.0.0",
    }),
    /not JSON: not json at all/u,
  );
});
