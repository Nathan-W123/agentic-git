import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";

import {
  normalizeServer,
  resolveServer,
  verifyServer,
} from "./server-address.js";

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

test("a build made for one deployment opens it without asking", () => {
  // The whole point of a hosted product: nobody installing it should be asked
  // to name the server it was built for.
  assert.equal(
    resolveServer({ fallback: "https://kumi.example.com" }),
    "https://kumi.example.com",
  );
});

test("a build made for nobody in particular still asks", () => {
  // Self-hosted, or an unconfigured build. `undefined` is what makes the
  // first-run window appear.
  assert.equal(resolveServer({}), undefined);
  // And a fallback that is not an address is no fallback at all — better to
  // ask than to open a window onto nothing.
  assert.equal(resolveServer({ fallback: "not an address" }), undefined);
  assert.equal(resolveServer({ fallback: "" }), undefined);
});

test("what somebody chose outranks what the build was made for", () => {
  assert.equal(
    resolveServer({
      saved: "https://mine.example.com",
      fallback: "https://kumi.example.com",
    }),
    "https://mine.example.com",
  );
});

test("the environment outranks everything, which is what makes it useful", () => {
  // Pointing a real build at a local gateway has to work without disturbing
  // the settings a real launch wrote.
  assert.equal(
    resolveServer({
      configured: "http://localhost:4000",
      saved: "https://mine.example.com",
      fallback: "https://kumi.example.com",
    }),
    "http://localhost:4000",
  );
});

test("Change Server escapes the baked-in address rather than bouncing off it", () => {
  // The failure this exists to prevent: Change Server clears the saved
  // address, the app relaunches, falls straight back to the fallback, and the
  // menu item looks broken. Somebody on a build with a default would have no
  // way to point it anywhere else.
  assert.equal(
    resolveServer({
      saved: "",
      fallback: "https://kumi.example.com",
      askedToChange: true,
    }),
    undefined,
  );
  // And once they have chosen, the flag is spent: the choice is what counts.
  assert.equal(
    resolveServer({
      saved: "https://elsewhere.example.com",
      fallback: "https://kumi.example.com",
      askedToChange: true,
    }),
    "https://elsewhere.example.com",
  );
});
