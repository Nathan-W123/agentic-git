import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  FrameReader,
  OPCODE_PONG,
  acceptKey,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  isWebSocketHandshake,
  rejectUpgrade,
} from "./ws-frame.js";

/**
 * Telling a worker that work exists, so it does not have to keep asking.
 *
 * ### Strictly an optimisation
 *
 * A worker polls `POST /workers/leases` every five seconds and that remains
 * the only thing that actually claims anything. This socket exists to collapse
 * the idle half of that: a task submitted a moment after a poll otherwise sits
 * there for the rest of the interval before anyone looks at it. A dropped
 * socket, a missed message, a worker that never connects at all — each costs
 * latency and nothing else, which is the property that makes it safe to add.
 *
 * That is also why the message carries no task. It says "ask again", not
 * "here is what to do": the worker still goes through the same authorized,
 * transactional claim it always did, so nothing about who may run what moves
 * onto a transport that was not carrying it before.
 *
 * ### No polling of its own
 *
 * Unlike the audit hub this one never reads the store. It is pushed to by the
 * submit path, so a deployment with no workers connected pays nothing for it.
 */

/** What a socket is allowed to hear about, resolved once at upgrade. */
export interface WorkerSocketAuthorization {
  organizationId: string;
}

export interface WorkerEventOptions {
  path?: string;
  authorize: (
    request: IncomingMessage,
    organizationId: string,
  ) => Promise<WorkerSocketAuthorization>;
}

interface WorkerClient {
  socket: Duplex;
  organizationId: string;
}

export class WorkerEventHub {
  private readonly clients = new Set<WorkerClient>();
  private readonly path: string;

  public constructor(private readonly options: WorkerEventOptions) {
    this.path = options.path ?? "/api/v1/workers/events";
  }

  /**
   * Handles an upgrade addressed to this hub, reporting whether it claimed it.
   *
   * The boolean is the contract the gateway's single `upgrade` listener needs:
   * Node hands every upgrade to every listener, so a hub that rejected
   * anything it did not recognise would close sockets meant for its
   * neighbours.
   */
  public async tryUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    let url: URL;
    try {
      // Origin-form only. Host is untrusted and never becomes a parser input.
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Invalid request URL");
      return true;
    }
    if (url.pathname !== this.path) {
      return false;
    }

    const organizationId = url.searchParams.get("organizationId");
    if (organizationId === null || organizationId.length === 0) {
      rejectUpgrade(socket, 400, "organizationId is required");
      return true;
    }
    // The shared guard takes the three headers by role rather than by wire
    // name, and narrows `key` to a string once it has checked it decodes to
    // the 16 bytes RFC 6455 requires.
    const handshake = {
      upgrade: request.headers.upgrade,
      version: request.headers["sec-websocket-version"],
      key: request.headers["sec-websocket-key"],
    };
    if (!isWebSocketHandshake(handshake)) {
      rejectUpgrade(socket, 400, "Invalid WebSocket request");
      return true;
    }

    let authorization: WorkerSocketAuthorization;
    try {
      authorization = await this.options.authorize(request, organizationId);
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(handshake.key)}\r\n\r\n`,
    );

    const client: WorkerClient = {
      socket,
      organizationId: authorization.organizationId,
    };
    this.clients.add(client);

    // Nothing a worker sends is acted on — it is a listener, and the claim it
    // makes in response goes over HTTP. Frames are still parsed so a ping is
    // answered and a close is honoured rather than leaking the socket.
    // Small caps on purpose: a worker is a listener here and has no reason to
    // send anything but a ping or a close, so anything larger is a client that
    // has misunderstood the channel rather than one to accommodate.
    const reader = new FrameReader({
      maxMessageBytes: 4 * 1024,
      maxBufferBytes: 16 * 1024,
    });
    const consume = (chunk: Buffer): void => {
      for (const event of reader.push(chunk)) {
        if (event.kind === "ping") {
          socket.write(encodeFrame(OPCODE_PONG, event.payload));
        } else if (event.kind === "close") {
          this.disconnect(client, 1000, "Closed by client");
        } else if (event.kind === "fault") {
          this.disconnect(client, event.code, event.reason);
        }
        // "text" is ignored deliberately: nothing a worker says over this
        // socket is acted on, because every claim it makes goes over HTTP.
      }
    };
    if (head.length > 0) {
      consume(head);
    }
    socket.on("data", consume);
    socket.on("error", () => this.drop(client));
    socket.on("close", () => this.drop(client));
    return true;
  }

  /**
   * Nudges every worker in one organization.
   *
   * Called from the submit path rather than from a timer. Best-effort by
   * design: a write that fails takes the socket out and leaves the worker on
   * its poll, which is where correctness lived all along.
   */
  public notify(organizationId: string): void {
    const message = encodeTextFrame({ type: "work_available" });
    for (const client of this.clients) {
      if (client.organizationId !== organizationId) {
        continue;
      }
      try {
        client.socket.write(message);
      } catch {
        this.drop(client);
      }
    }
  }

  public close(): void {
    for (const client of [...this.clients]) {
      this.disconnect(client, 1001, "Server is shutting down");
    }
  }

  public get connections(): number {
    return this.clients.size;
  }

  private disconnect(client: WorkerClient, code: number, reason: string): void {
    if (!this.clients.delete(client)) {
      return;
    }
    try {
      client.socket.write(encodeCloseFrame(code, reason));
    } catch {
      // The socket is already gone, which is the state we were heading for.
    }
    client.socket.destroy();
  }

  private drop(client: WorkerClient): void {
    this.clients.delete(client);
  }
}
