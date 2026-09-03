import assert from "node:assert/strict";
import { createServer, type Server, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import {
  dialMcp,
  isForbiddenAddress,
  McpDialError,
  readRpcReply,
  vetDestination,
} from "./mcp-dialer.js";

/**
 * A server that behaves the way the ones out there actually behave.
 *
 * The two framings, the chunked answer with no length, the redirect, the reply
 * that never comes and the one that never stops. Written as one server with a
 * path per behaviour so a test names the misbehaviour it is about.
 */
async function hostileServer(t: TestContext): Promise<{
  origin: string;
  opened: () => number;
}> {
  let opened = 0;
  const server: Server = createServer((incoming, response) => {
    opened += 1;
    const path = incoming.url ?? "/";
    // Every case reads the body first: a server that answers without draining
    // it makes the client's write fail rather than its read.
    incoming.resume();
    if (path === "/json") {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(body);
      return;
    }
    if (path === "/sse") {
      // Chunked, no content-length, and it does not close after answering —
      // exactly what Context7 does. A reader that waits for the end hangs.
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(": a comment nobody should parse\n\n");
      response.write('event: message\ndata: {"jsonrpc":"2.0","id":99,"result":"not yours"}\n\n');
      response.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
      // Deliberately never ended.
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "https://elsewhere.invalid/mcp" }).end();
      return;
    }
    if (path === "/huge") {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      const pump = (): void => {
        while (response.write(chunk)) {
          /* until the socket pushes back */
        }
      };
      response.on("drain", pump);
      pump();
      return;
    }
    if (path === "/silent") {
      // Headers, then nothing, forever.
      response.writeHead(200, { "content-type": "application/json" });
      return;
    }
    if (path === "/teapot") {
      response.writeHead(418, { "content-type": "application/json" }).end("{}");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, opened: () => opened };
}

/** The dial, aimed at the local server: http transport, loopback allowed. */
async function dialLocal(
  origin: string,
  path: string,
  overrides: Partial<Parameters<typeof dialMcp>[0]> = {},
): Promise<unknown> {
  return await dialMcp({
    url: `${origin}${path}`.replace(/^http:/u, "https:"),
    headers: { authorization: "Bearer secret-that-must-not-travel" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    // The policy checks are asserted on their own below. Here the subject is
    // the wire behaviour, so the transport and the resolver are the local
    // server rather than a certificate authority and real DNS.
    resolve: async () => ["93.184.216.34"],
    transport: ((url: URL, options: object, callback: never) =>
      httpRequest(
        String(url).replace(/^https:/u, "http:"),
        options,
        callback,
      )) as never,
    ...overrides,
  });
}

test("both framings are read, because the server picks per response", async (t) => {
  const server = await hostileServer(t);

  // JSON, which is what Sentry answers.
  assert.deepEqual(await dialLocal(server.origin, "/json"), {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  });

  // An event stream that never closes, carrying a comment and somebody else's
  // reply before ours. Reading to the end would wait out the deadline; taking
  // the first frame would answer with id 99.
  assert.deepEqual(await dialLocal(server.origin, "/sse"), {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  });
});

test("a redirect is an error, never a second request", async (t) => {
  const server = await hostileServer(t);
  const before = server.opened();
  await assert.rejects(
    async () => await dialLocal(server.origin, "/redirect"),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "redirect",
  );
  // The point is not the error, it is that nothing was dialled twice: the
  // bearer header would have gone to whatever the Location named.
  assert.equal(server.opened(), before + 1);
});

test("a response that never stops is cut off at the cap", async (t) => {
  const server = await hostileServer(t);
  await assert.rejects(
    async () => await dialLocal(server.origin, "/huge", { maxBytes: 200_000 }),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "too_large",
  );
});

test("a response that never arrives is cut off at the deadline", async (t) => {
  const server = await hostileServer(t);
  await assert.rejects(
    async () => await dialLocal(server.origin, "/silent", { timeoutMs: 250 }),
    // The socket is destroyed with the dial error; either surfacing is a
    // refusal rather than a hang, which is the whole assertion.
    (error: unknown) => error instanceof Error,
  );
});

test("an error status is reported rather than parsed", async (t) => {
  const server = await hostileServer(t);
  await assert.rejects(
    async () => await dialLocal(server.origin, "/teapot"),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "http_status",
  );
});

test("plain http is refused at dial time, whatever is stored", async () => {
  // The stored-URL validator permits http to loopback, and correctly so: it
  // was written when the worker was the dialer. Rows written under that rule
  // already exist, so refusing at write time alone would not cover them.
  await assert.rejects(
    async () => await vetDestination("http://localhost:9000/mcp"),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "insecure",
  );
  await assert.rejects(
    async () => await vetDestination("https://user:pass@example.invalid/mcp"),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "credentials",
  );
});

test("a name that resolves inside our own network is refused", async () => {
  // The shape that matters: a perfectly ordinary https URL whose hostname
  // answers with a private address. Nothing about the URL says so.
  await assert.rejects(
    async () =>
      await vetDestination("https://tools.example.com/mcp", async () => [
        "169.254.169.254",
      ]),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "private_address",
  );

  // One public and one private. Taking the public one would be choosing to be
  // fooled: the socket is free to use either.
  await assert.rejects(
    async () =>
      await vetDestination("https://tools.example.com/mcp", async () => [
        "93.184.216.34",
        "10.0.0.5",
      ]),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "private_address",
  );

  const allowed = await vetDestination(
    "https://tools.example.com/mcp",
    async () => ["93.184.216.34"],
  );
  assert.deepEqual(allowed.addresses, ["93.184.216.34"]);
});

test("the address ranges cover the ways in, including the mapped form", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata endpoint
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1", // unique-local
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // the oldest way past a check that splits the families
    "::ffff:10.0.0.1",
    "not-an-address",
  ]) {
    assert.equal(isForbiddenAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800::1"]) {
    assert.equal(isForbiddenAddress(address), false, address);
  }
});

test("a frame that is not ours, and one that is not JSON, are stepped over", async () => {
  const frames = [
    ": keep-alive\n\n",
    "event: message\ndata: not json at all\n\n",
    'event: message\ndata: {"jsonrpc":"2.0","id":"other","result":1}\n\n',
    'event: message\ndata: {"jsonrpc":"2.0","id":"mine","result":{"ok":true}}\n\n',
  ];
  async function* stream(): AsyncGenerator<Uint8Array> {
    for (const frame of frames) {
      yield new TextEncoder().encode(frame);
    }
  }
  assert.deepEqual(await readRpcReply(stream(), "text/event-stream", "mine"), {
    jsonrpc: "2.0",
    id: "mine",
    result: { ok: true },
  });
});

test("a stream that ends without answering says so rather than hanging", async () => {
  async function* stream(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(': nothing to say\n\n');
  }
  await assert.rejects(
    async () => await readRpcReply(stream(), "text/event-stream", 1),
    (error: unknown) =>
      error instanceof McpDialError && error.reason === "unreadable",
  );
});
