/**
 * The one place this control plane talks to somebody else's MCP server.
 *
 * ### Why this is its own file, built before anything calls it
 *
 * Until now the gateway had no outbound HTTP client at all: the mailer's fetch
 * is the only request in the process with a timeout, and both other outbound
 * clients (Stripe, GitHub) have neither a deadline nor a response cap. That was
 * survivable while every address the product dialled was one we had chosen.
 * Proxying an MCP server inverts it — the address is supplied by a project
 * admin, and the process that dials it is the single-instance control plane
 * that also serves the dashboard.
 *
 * So this is written once, with every property present from the first commit,
 * and tested against a deliberately hostile server before a single caller
 * exists. Adding the fifth guard later, to a client already in production, is
 * how the four that shipped come to be trusted.
 *
 * ### The five properties, and what each one is for
 *
 * - **No redirects.** A 3xx is an error, never followed. This is the guard
 *   that closes two holes at once: a secret header following a redirect to a
 *   host the operator never approved, and the self-dispatch loop that
 *   `mcpUrlLoopsBack` cannot see because it inspects only the URL as stored.
 * - **https, checked at dial time.** The stored-URL validator permits
 *   `http://localhost`, and correctly so — it was written when the *worker*
 *   was the dialer and a loopback listener was the one place a secret could
 *   not be read off the wire. With the gateway dialling, that same row is SSRF
 *   into this container. Rows predating this feature are already stored, so
 *   the check cannot live only at write time.
 * - **Addresses vetted, then pinned.** A hostname is resolved, every address
 *   is checked against the loopback, private, link-local and carrier ranges,
 *   and the socket is then given a `lookup` that can only return an address
 *   already vetted. Checking and then connecting by name would leave DNS
 *   rebinding wide open.
 * - **A deadline and a byte cap, both enforced while reading.** The cap cannot
 *   be a `Content-Length` check: a real server (Context7) answers chunked with
 *   no length at all, so the only place to stop is mid-stream.
 * - **Framing chosen by the response, not by us.** Streamable HTTP lets the
 *   server pick per response, and the same endpoint mixes both: Sentry answers
 *   JSON, Context7 and DeepWiki answer `text/event-stream`. A client that
 *   assumes either one is broken against half the servers it will meet.
 */

import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { IncomingMessage } from "node:http";

/** What a dial is allowed to spend before it is somebody else's problem. */
export const MCP_DIAL_TIMEOUT_MS = 20_000;

/**
 * The most a proxied answer may be.
 *
 * A tool result is text, and this is already generous for one. The number
 * matters less than the fact that it is enforced against the stream rather
 * than against a header the server is free not to send.
 */
export const MCP_DIAL_MAX_BYTES = 1_000_000;

/** How a dial failed, for a caller that has to say so in a tool result. */
export class McpDialError extends Error {
  public constructor(
    message: string,
    /** Stable enough to branch on; the message is for a person. */
    public readonly reason:
      | "insecure"
      | "credentials"
      | "unresolvable"
      | "private_address"
      | "redirect"
      | "http_status"
      | "too_large"
      | "timeout"
      | "unreadable"
      | "transport",
  ) {
    super(message);
    this.name = "McpDialError";
  }
}

/**
 * Whether one resolved address is somewhere this process must not reach.
 *
 * The IPv4-mapped form is unwrapped first and checked as IPv4, because
 * `::ffff:127.0.0.1` is the oldest way past a check that looks at the two
 * families separately.
 */
export function isForbiddenAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value);
  if (mapped?.[1] !== undefined) {
    return isForbiddenAddress(mapped[1]);
  }
  if (value.includes(":")) {
    // Unspecified and loopback.
    if (value === "::" || value === "::1") {
      return true;
    }
    // Unique-local fc00::/7 and link-local fe80::/10.
    return /^f[cd]/u.test(value) || /^fe[89ab]/u.test(value);
  }
  const octets = value.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not an address this code understands, so not an address it will vouch
    // for either.
    return true;
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the cloud metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** Every address a hostname currently answers with. */
export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  await new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });

/**
 * Decides whether this URL may be dialled, and returns the addresses it may be
 * dialled at.
 *
 * Returning the addresses rather than a boolean is the point: the caller pins
 * the socket to exactly this list, so nothing can answer differently between
 * the check and the connection.
 */
export async function vetDestination(
  rawUrl: string,
  resolve: Resolver = systemResolver,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpDialError(`${rawUrl} is not a URL this can dial.`, "transport");
  }
  if (url.username !== "" || url.password !== "") {
    throw new McpDialError(
      "A server URL must not carry credentials in the address.",
      "credentials",
    );
  }
  if (url.protocol !== "https:") {
    // Deliberately stricter than the stored-URL validator, which allows
    // http to loopback for a worker on its own machine. Nothing this process
    // dials may be plain http, including the rows written before that
    // distinction mattered.
    throw new McpDialError(
      `Kumi will only reach an MCP server over https, and ${url.protocol}//${url.host} is not.`,
      "insecure",
    );
  }
  let addresses: string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw new McpDialError(`${url.hostname} could not be resolved.`, "unresolvable");
  }
  if (addresses.length === 0) {
    throw new McpDialError(`${url.hostname} resolved to nothing.`, "unresolvable");
  }
  const forbidden = addresses.filter((address) => isForbiddenAddress(address));
  if (forbidden.length > 0) {
    // Every address, not merely the first. A name that answers with one public
    // and one private address is the interesting case, and taking the public
    // one would be choosing to be fooled.
    throw new McpDialError(
      `${url.hostname} resolves to ${forbidden[0]}, which is inside this deployment's own network.`,
      "private_address",
    );
  }
  return { url, addresses };
}

/**
 * Reads one JSON-RPC reply out of a response, whichever way it is framed.
 *
 * Both shapes occur on the same endpoint, so this branches on what actually
 * arrived rather than on what was asked for. The stream is abandoned the
 * moment the matching id is in hand: an event stream does not end when it has
 * answered, it waits for the next request, so waiting for the end is waiting
 * for the deadline.
 */
export async function readRpcReply(
  stream: AsyncIterable<Uint8Array>,
  contentType: string,
  id: number | string,
  maxBytes: number = MCP_DIAL_MAX_BYTES,
): Promise<unknown> {
  const streamed = /text\/event-stream/iu.test(contentType);
  const decoder = new TextDecoder();
  let text = "";
  let seen = 0;
  for await (const chunk of stream) {
    seen += chunk.byteLength;
    if (seen > maxBytes) {
      throw new McpDialError(
        `The server sent more than ${maxBytes} bytes in one answer.`,
        "too_large",
      );
    }
    text += decoder.decode(chunk, { stream: true });
    if (!streamed) {
      continue;
    }
    // Frames are separated by a blank line. Anything before the last complete
    // separator can be examined; the remainder stays buffered.
    const boundary = text.lastIndexOf("\n\n");
    if (boundary === -1) {
      continue;
    }
    const found = matchingFrame(text.slice(0, boundary), id);
    if (found !== undefined) {
      return found;
    }
  }
  text += decoder.decode();
  if (streamed) {
    const found = matchingFrame(text, id);
    if (found !== undefined) {
      return found;
    }
    throw new McpDialError(
      "The server's event stream ended without answering.",
      "unreadable",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new McpDialError("The server's answer was not JSON.", "unreadable");
  }
}

/** The first `data:` payload in these frames whose JSON-RPC id matches. */
function matchingFrame(frames: string, id: number | string): unknown {
  for (const frame of frames.split(/\n\n/u)) {
    const payload = frame
      .split(/\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (payload === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A frame that is not JSON is not this reply. Notices and keep-alives
      // travel on the same stream.
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { id?: unknown }).id === id
    ) {
      return parsed;
    }
  }
  return undefined;
}

/** How the request is actually put on the wire; swapped in tests. */
export type Transport = typeof httpsRequest;

/**
 * Sends one JSON-RPC message to an approved MCP server and reads one reply.
 *
 * Every guard above is applied on the way. Nothing here retries: a retry
 * multiplies whatever the far end is doing to this process, and the caller is
 * a tool result that can say so.
 */
export async function dialMcp(input: {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: { readonly jsonrpc: "2.0"; readonly id: number | string; readonly method: string; readonly params?: unknown };
  timeoutMs?: number;
  maxBytes?: number;
  resolve?: Resolver;
  transport?: Transport;
}): Promise<unknown> {
  const { url, addresses } = await vetDestination(input.url, input.resolve);
  const timeoutMs = input.timeoutMs ?? MCP_DIAL_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? MCP_DIAL_MAX_BYTES;
  const send = input.transport ?? httpsRequest;
  const payload = Buffer.from(JSON.stringify(input.body), "utf8");
  const vetted = new Set(addresses);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const call = send(
      url,
      {
        method: "POST",
        headers: {
          ...input.headers,
          "content-type": "application/json",
          // Both, because the server chooses. Claiming only one is how a
          // client ends up unable to read half the servers it meets.
          accept: "application/json, text/event-stream",
          "content-length": String(payload.byteLength),
        },
        // The socket may only reach an address already vetted above. Without
        // this the name is resolved a second time, by the socket, and a name
        // that answers differently the second time is the whole of DNS
        // rebinding.
        lookup: (hostname, options, callback) => {
          void hostname;
          const address = addresses[0] ?? "";
          if (!vetted.has(address)) {
            callback(new Error("address was not vetted"), "", 4);
            return;
          }
          const family = address.includes(":") ? 6 : 4;
          if (options.all === true) {
            callback(null, [{ address, family }] as never, family);
            return;
          }
          callback(null, address as never, family);
        },
      },
      resolve,
    );
    call.setTimeout(timeoutMs, () => {
      call.destroy(
        new McpDialError(
          `The server did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          "timeout",
        ),
      );
    });
    call.on("error", reject);
    call.end(payload);
  });

  try {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      // Never followed. See the header comment: this is the guard that keeps a
      // secret header from travelling to a host nobody approved, and keeps a
      // 302 from pointing this deployment back at its own MCP endpoint.
      throw new McpDialError(
        `The server answered ${status} and Kumi does not follow redirects.`,
        "redirect",
      );
    }
    if (status < 200 || status >= 300) {
      throw new McpDialError(`The server answered ${status}.`, "http_status");
    }
    return await readRpcReply(
      response,
      String(response.headers["content-type"] ?? ""),
      input.body.id,
      maxBytes,
    );
  } finally {
    // Whatever happened, this process is done reading. An event stream stays
    // open indefinitely otherwise, holding a socket for a request that has
    // already been answered.
    response.destroy();
  }
}
