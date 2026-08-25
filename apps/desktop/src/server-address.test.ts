import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { normalizeServer, verifyServer } from "./server-address.js";

test("an address is read the way somebody would write one", () => {
  // The scheme is the part people leave off, and refusing them for it would
  // be refusing them for nothing.
  assert.equal(normalizeServer("kumi.example.com"), "https://kumi.example.com");
  assert.equal(normalizeServer("  kumi.example.com/  "), "https://kumi.example.com");
  assert.equal(normalizeServer("https://kumi.example.com/"), "https://kumi.example.com");
  // A local gateway is addressed over plain http, so http survives being asked
  // for explicitly even though it is never assumed.
  assert.equal(normalizeServer("http://localhost:4000"), "http://localhost:4000");
  // A Kumi served under a path keeps it.
  assert.equal(normalizeServer("https://example.com/kumi/"), "https://example.com/kumi");
});

test("what is not an address comes back as nothing rather than as a guess", () => {
  assert.equal(normalizeServer(""), undefined);
  assert.equal(normalizeServer("   "), undefined);
  assert.equal(normalizeServer(undefined), undefined);
  // Guessing `https://` in front of these would produce something that parses
  // and is still wrong, which is worse than saying so.
  assert.equal(normalizeServer("not an address"), undefined);
  assert.equal(normalizeServer("ftp://files.example.com"), undefined);
  assert.equal(normalizeServer("file:///etc/passwd"), undefined);
});

/** A deployment, reduced to the one route that answers without a credential. */
async function stubServer(
  health: () => { status: number; body: unknown },
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/health") {
      const answer = health();
      response
        .writeHead(answer.status, { "Content-Type": "application/json" })
        .end(JSON.stringify(answer.body));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () =>
      await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a deployment that answers is accepted", async () => {
  const control = await stubServer(() => ({
    status: 200,
    body: { status: "ok", database: "ready", setupRequired: false },
  }));
  try {
    assert.deepEqual(await verifyServer(control.origin, 2_000), { ok: true });
  } finally {
    await control.close();
  }
});

test("something that answers but is not Kumi is named as such", async () => {
  // The failure worth catching: an address that is somebody's blog, or a proxy
  // that returns a page for everything. It is reachable, so "could not reach"
  // would be a lie, and the app would otherwise open a window onto it.
  const control = await stubServer(() => ({ status: 200, body: { hello: "world" } }));
  try {
    const checked = await verifyServer(control.origin, 2_000);
    assert.equal(checked.ok, false);
    assert.match(checked.ok ? "" : checked.message, /not a Kumi deployment/u);
  } finally {
    await control.close();
  }
});

test("a server that refuses is reported with what it said", async () => {
  const control = await stubServer(() => ({ status: 502, body: {} }));
  try {
    const checked = await verifyServer(control.origin, 2_000);
    assert.equal(checked.ok, false);
    assert.match(checked.ok ? "" : checked.message, /answered with 502/u);
  } finally {
    await control.close();
  }
});

test("an address nothing is listening on does not hang the setup screen", async () => {
  // Closed immediately, so the port is almost certainly free: the point is a
  // sentence rather than a spinner that never resolves.
  const control = await stubServer(() => ({ status: 200, body: {} }));
  const origin = control.origin;
  await control.close();

  const checked = await verifyServer(origin, 2_000);
  assert.equal(checked.ok, false);
  assert.match(checked.ok ? "" : checked.message, /Could not reach/u);
});
