import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import { resolveProxyScriptPath } from "./egress-gateway.js";

/**
 * Exercises the allowlisting proxy over real sockets, in process.
 *
 * The container half of the mechanism — that an `--internal` network leaves no
 * other route out — needs a live daemon and is covered by
 * `scripts/verify-egress-allowlist.mjs`. What is checked here is the decision
 * the proxy makes once a request reaches it, which is the part that has to be
 * right for the allowlist to mean anything, and which needs no Docker and no
 * traffic that leaves the machine.
 */

interface ProxyModule {
  parseAuthority(authority: unknown): { host: string; port: number } | undefined;
  isAllowedHost(host: string, allow: readonly string[]): boolean;
  parseList(value: string | undefined): string[];
  createProxyServer(options: {
    allow: readonly string[];
    ports: readonly number[];
    log?: (event: string, fields: Record<string, unknown>) => void;
  }): Server;
}

const proxy = (await import(
  pathToFileURL(await resolveProxyScriptPath()).href
)) as ProxyModule;

test("a CONNECT authority is parsed only when it is unambiguous", () => {
  assert.deepEqual(proxy.parseAuthority("api.anthropic.com:443"), {
    host: "api.anthropic.com",
    port: 443,
  });
  // A trailing dot is the same host to a resolver, so it must not become a
  // different string to the allowlist.
  assert.deepEqual(proxy.parseAuthority("api.anthropic.com.:443"), {
    host: "api.anthropic.com",
    port: 443,
  });
  assert.deepEqual(proxy.parseAuthority("API.Anthropic.COM:443"), {
    host: "api.anthropic.com",
    port: 443,
  });

  for (const malformed of [
    "api.anthropic.com",
    "api.anthropic.com:",
    ":443",
    "api.anthropic.com:44a",
    "api.anthropic.com:0",
    "api.anthropic.com:70000",
    "[::1]:443",
    "http://api.anthropic.com:443/path",
    undefined,
  ]) {
    assert.equal(
      proxy.parseAuthority(malformed),
      undefined,
      `expected ${String(malformed)} to be refused`,
    );
  }
});

test("a dot-prefixed allowlist entry matches subdomains and not lookalikes", () => {
  const allow = [".googleapis.com", "api.anthropic.com"];

  assert.ok(proxy.isAllowedHost("generativelanguage.googleapis.com", allow));
  assert.ok(proxy.isAllowedHost("api.anthropic.com", allow));

  // The apex itself is not admitted by a dot-prefixed entry.
  assert.ok(!proxy.isAllowedHost("googleapis.com", allow));
  // The attack the dot prefix exists to stop: a suffix that is not a parent.
  assert.ok(!proxy.isAllowedHost("googleapis.com.evil.test", allow));
  assert.ok(!proxy.isAllowedHost("notapi.anthropic.com", allow));
  assert.ok(!proxy.isAllowedHost("api.anthropic.com.evil.test", allow));
  assert.ok(!proxy.isAllowedHost("evil.test", allow));
});

async function listen(server: net.Server | Server): Promise<number> {
  await new Promise<void>((resolve) => {
    (server as net.Server).listen(0, "127.0.0.1", resolve);
  });
  const address = (server as net.Server).address();
  if (address === null || typeof address === "string") {
    throw new Error("the server did not bind a TCP port");
  }
  return address.port;
}

/**
 * Speaks CONNECT to the proxy and returns everything it sent back.
 *
 * When `payload` is given the tunnel is exercised too: it is written once the
 * proxy reports the tunnel open, and the socket is closed after the echo
 * arrives.
 */
async function connectThrough(
  proxyPort: number,
  authority: string,
  payload?: string,
): Promise<{ status: string; body: string }> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let buffer = "";
    let sent = false;
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`timed out talking to the proxy about ${authority}`));
    });
    socket.on("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const open = buffer.includes("200 Connection Established");
      if (payload !== undefined && open && !sent) {
        sent = true;
        socket.write(payload);
        return;
      }
      if (payload === undefined || buffer.includes(payload)) {
        socket.end();
      }
    });
    socket.on("close", () => {
      resolve({ status: buffer.split("\r\n")[0] ?? "", body: buffer });
    });
    socket.on("error", reject);
  });
}

test("the proxy admits only allowlisted hosts and ports", async (t) => {
  // Stands in for a vendor API. Nothing in this test leaves the machine.
  const upstream = net.createServer((socket) => {
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);

  const decisions: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const server = proxy.createProxyServer({
    // 127.0.0.1 rather than a name, so an admitted host actually resolves and
    // the tunnel can be observed end to end without any DNS.
    allow: ["127.0.0.1"],
    ports: [upstreamPort],
    log: (event, fields) => decisions.push({ event, fields }),
  });
  const proxyPort = await listen(server);

  t.after(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  await t.test("an allowlisted host tunnels bytes both ways", async () => {
    const result = await connectThrough(
      proxyPort,
      `127.0.0.1:${upstreamPort}`,
      "round-trip-probe",
    );
    assert.match(result.status, /200/u);
    assert.ok(
      result.body.includes("round-trip-probe"),
      "the echo did not come back through the tunnel",
    );
    assert.ok(
      decisions.some((entry) => entry.event === "allowed"),
      "the admitted host was not recorded in the audit log",
    );
  });

  await t.test("a host outside the allowlist is refused", async () => {
    const result = await connectThrough(
      proxyPort,
      `blocked.test:${upstreamPort}`,
    );
    assert.match(result.status, /403/u);
    assert.ok(
      decisions.some(
        (entry) =>
          entry.event === "denied" &&
          entry.fields["reason"] === "host" &&
          entry.fields["host"] === "blocked.test",
      ),
      "the refusal was not recorded in the audit log",
    );
  });

  await t.test("an allowlisted host on another port is refused", async () => {
    const result = await connectThrough(proxyPort, "127.0.0.1:8443");
    assert.match(result.status, /403/u);
    assert.ok(
      decisions.some(
        (entry) => entry.event === "denied" && entry.fields["reason"] === "port",
      ),
      "the port refusal was not recorded",
    );
  });

  await t.test("plain HTTP proxying is refused outright", async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let buffer = "";
      socket.setTimeout(5_000, () => {
        socket.destroy();
        reject(new Error("timed out"));
      });
      socket.on("connect", () => {
        socket.write(
          "GET http://blocked.test/ HTTP/1.1\r\nHost: blocked.test\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        socket.end();
      });
      socket.on("close", () => resolve(buffer.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    assert.match(status, /403/u);
  });
});
