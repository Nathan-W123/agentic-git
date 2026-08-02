#!/usr/bin/env node
/**
 * Allowlisting forward proxy for sandboxed agent containers.
 *
 * The agent container sits on an `--internal` Docker network, so it has no
 * route off the host at all. This proxy is the only container attached to both
 * that network and a bridged one, which makes it the single egress path — and
 * it refuses every host that is not on its allowlist.
 *
 * Only `CONNECT` is served. The proxy establishes a TCP tunnel and never sees
 * plaintext, so an agent's API credentials are not exposed to it and no TLS
 * interception is involved. Plain-HTTP proxying is refused outright: it would
 * be the one path where a request body crossed this process in the clear.
 *
 * The allowlist is authority-only. `CONNECT api.anthropic.com:443` names a host
 * and a port and nothing else, so this can gate *who* is reachable but never
 * *what* is requested of them. Anything finer has to be enforced at a layer
 * that can read the request, which by design this one cannot.
 *
 * Configuration is by environment, because the process is launched by
 * `docker run` with no argument shell:
 *
 *   COORD_EGRESS_ALLOW   Comma-separated hosts. An entry starting with "."
 *                        matches any subdomain of it, so ".googleapis.com"
 *                        admits "generativelanguage.googleapis.com" but not
 *                        "googleapis.com.evil.test".
 *   COORD_EGRESS_PORT    Listen port. Defaults to 3128.
 *   COORD_EGRESS_PORTS   Comma-separated destination ports. Defaults to 443.
 *
 * Importing this module has no side effects; the server starts only when the
 * file is executed directly, so the matching rules can be unit-tested in
 * process rather than only through a container.
 */

import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONNECT_TIMEOUT_MS = 30_000;
/** Bounds how long a wholly idle tunnel is kept open. */
const IDLE_TIMEOUT_MS = 300_000;

export function parseList(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Splits a CONNECT authority into host and port.
 *
 * Returns undefined for anything that is not exactly `host:port`, including
 * bracketed IPv6 literals. Refusing what cannot be parsed unambiguously is the
 * point: a target this cannot read is a target it cannot check.
 */
export function parseAuthority(authority) {
  if (typeof authority !== "string" || authority.includes("/")) {
    return undefined;
  }
  const separator = authority.lastIndexOf(":");
  if (separator <= 0 || separator === authority.length - 1) {
    return undefined;
  }
  const host = authority.slice(0, separator).toLowerCase();
  const portText = authority.slice(separator + 1);
  if (!/^\d+$/u.test(portText)) {
    return undefined;
  }
  const port = Number.parseInt(portText, 10);
  if (host.length === 0 || host.includes(":") || port <= 0 || port > 65_535) {
    return undefined;
  }
  // A trailing dot names the same host to a resolver but not to a string
  // comparison, so it is normalized before matching rather than after.
  return { host: host.endsWith(".") ? host.slice(0, -1) : host, port };
}

/**
 * Whether `host` is admitted by `allow`.
 *
 * A ".suffix" entry matches subdomains only, never the bare suffix itself, so
 * an allowlist can name a vendor's subdomain space without also admitting
 * whatever the apex happens to serve.
 */
export function isAllowedHost(host, allow) {
  return allow.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) : host === entry,
  );
}

/**
 * Builds the proxy server.
 *
 * `log` is injectable so tests can assert on decisions without parsing stdout.
 */
export function createProxyServer({ allow, ports, log = defaultLog }) {
  const allowedPorts = new Set(ports);

  const server = http.createServer((request, response) => {
    // Reached only for non-CONNECT verbs: plain-HTTP forward proxying.
    log("denied", { reason: "non-connect", method: request.method });
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("This proxy serves CONNECT only\n");
  });

  server.on("connect", (request, clientSocket, head) => {
    const target = parseAuthority(request.url);

    if (target === undefined) {
      log("denied", { reason: "unparseable-authority", authority: request.url });
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!allowedPorts.has(target.port)) {
      log("denied", { reason: "port", host: target.host, port: target.port });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (!isAllowedHost(target.host, allow)) {
      log("denied", { reason: "host", host: target.host, port: target.port });
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    const upstream = net.connect(target.port, target.host);
    let settled = false;

    const teardown = (reason, detail) => {
      if (!settled) {
        settled = true;
        log("failed", { host: target.host, port: target.port, reason, detail });
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      upstream.destroy();
      clientSocket.destroy();
    };

    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      teardown("connect-timeout");
    });

    upstream.on("connect", () => {
      settled = true;
      log("allowed", { host: target.host, port: target.port });
      // The connect timeout guarded dialling; a live tunnel is governed by the
      // idle timeout instead, or a long-lived streamed response would be cut.
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => {
        upstream.destroy();
        clientSocket.destroy();
      });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head !== undefined && head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", (error) => {
      teardown("upstream-error", error.message);
    });
    clientSocket.on("error", () => {
      upstream.destroy();
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  return server;
}

function defaultLog(event, fields) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function main() {
  const listenPort = Number.parseInt(process.env.COORD_EGRESS_PORT ?? "3128", 10);
  const allow = parseList(process.env.COORD_EGRESS_ALLOW);
  const ports = parseList(process.env.COORD_EGRESS_PORTS ?? "443").map((entry) =>
    Number.parseInt(entry, 10),
  );

  const fatal = (reason) => {
    console.error(JSON.stringify({ event: "fatal", reason }));
    process.exit(2);
  };

  // Failing closed on an empty allowlist keeps a misconfiguration from
  // silently producing a proxy that forwards nothing, which would look like a
  // network fault rather than a configuration error.
  if (allow.length === 0) {
    fatal("COORD_EGRESS_ALLOW is empty");
  }
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65_535) {
    fatal("COORD_EGRESS_PORT is invalid");
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      fatal("COORD_EGRESS_PORTS is invalid");
    }
  }

  const server = createProxyServer({ allow, ports });
  server.listen(listenPort, "0.0.0.0", () => {
    // The readiness probe waits for this line, so it must be the first thing
    // written once the socket is actually accepting.
    defaultLog("listening", { port: listenPort, allow, ports });
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}
