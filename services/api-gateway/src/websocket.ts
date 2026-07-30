import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type {
  CoordinationStore,
  ProjectRecord,
} from "@coord/persistence";

import type { AuthenticatedPrincipal } from "./auth.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_BUFFER = 1024 * 1024;

interface WebSocketClient {
  socket: Duplex;
  principal: AuthenticatedPrincipal;
  project: ProjectRecord;
  cursor: number;
  input: Buffer;
  closed: boolean;
  nextAuthorizationAt: number;
}

export interface WebSocketAuthorization {
  principal: AuthenticatedPrincipal;
  project: ProjectRecord;
}

export interface AuditWebSocketOptions {
  path?: string;
  pollIntervalMs?: number;
  authorize: (
    request: IncomingMessage,
    projectId: string,
  ) => Promise<WebSocketAuthorization>;
  reauthorize: (
    authorization: WebSocketAuthorization,
  ) => Promise<WebSocketAuthorization>;
  reauthorizeIntervalMs?: number;
}

function frame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function textFrame(value: unknown): Buffer {
  return frame(0x1, Buffer.from(JSON.stringify(value), "utf8"));
}

function closeFrame(code: number, reason: string): Buffer {
  const message = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + message.length);
  payload.writeUInt16BE(code, 0);
  message.copy(payload, 2);
  return frame(0x8, payload);
}

function reject(socket: Duplex, status: number, message: string): void {
  const body = Buffer.from(message, "utf8");
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n` +
      message,
  );
}

function parseCursor(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const cursor = Number.parseInt(value, 10);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

export class AuditWebSocketHub {
  private readonly clients = new Set<WebSocketClient>();
  private readonly runProjects = new Map<string, string | undefined>();
  private readonly path: string;
  private readonly pollIntervalMs: number;
  private readonly reauthorizeIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  public constructor(
    private readonly store: CoordinationStore,
    private readonly options: AuditWebSocketOptions,
  ) {
    this.path = options.path ?? "/api/v1/events";
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.reauthorizeIntervalMs = options.reauthorizeIntervalMs ?? 5_000;
    for (const [name, value] of [
      ["pollIntervalMs", this.pollIntervalMs],
      ["reauthorizeIntervalMs", this.reauthorizeIntervalMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  public attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      void this.tryUpgrade(request, socket, head)
        .then((claimed) => {
          if (!claimed && !socket.destroyed) {
            reject(socket, 404, "Not Found");
          }
        })
        .catch(() => {
          if (!socket.destroyed) {
            reject(socket, 500, "WebSocket upgrade failed");
          }
        });
    });
    this.startPolling();
  }

  /**
   * Handles an upgrade addressed to this hub's path, reporting whether it
   * claimed the request.
   *
   * The gateway mounts a second WebSocket endpoint (live collaborative
   * editing) on the same server, and Node has no way to stop an `upgrade`
   * listener from seeing every request — so routing has to be explicit rather
   * than each hub rejecting whatever it does not recognize.
   */
  public async tryUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      reject(socket, 400, "Invalid request URL");
      return true;
    }
    if (url.pathname !== this.path) {
      return false;
    }
    await this.upgrade(request, socket, head);
    return true;
  }

  /** Begins polling the audit log. `attach` does this for you. */
  public startPolling(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.polling) {
        return;
      }
      this.polling = true;
      void this.poll().finally(() => {
        this.polling = false;
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  public close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const client of this.clients) {
      this.disconnect(client, 1001, "Server is shutting down");
    }
  }

  public get connections(): number {
    return this.clients.size;
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let url: URL;
    try {
      // Upgrade routing needs only the origin-form path. Host is untrusted and
      // must never become a URL parser input.
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      reject(socket, 400, "Invalid request URL");
      return;
    }
    if (url.pathname !== this.path) {
      reject(socket, 404, "Not Found");
      return;
    }
    const projectId = url.searchParams.get("projectId");
    if (projectId === null || projectId.length === 0) {
      reject(socket, 400, "projectId is required");
      return;
    }
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13"
    ) {
      reject(socket, 400, "Invalid WebSocket request");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (
      typeof key !== "string" ||
      key.length > 128 ||
      Buffer.from(key, "base64").byteLength !== 16
    ) {
      reject(socket, 400, "Invalid WebSocket key");
      return;
    }

    let authorization: WebSocketAuthorization;
    try {
      authorization = await this.options.authorize(request, projectId);
    } catch {
      reject(socket, 401, "Unauthorized");
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`, "ascii")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client: WebSocketClient = {
      socket,
      principal: authorization.principal,
      project: authorization.project,
      cursor: parseCursor(url.searchParams.get("after")),
      input: head,
      closed: false,
      nextAuthorizationAt: Date.now() + this.reauthorizeIntervalMs,
    };
    this.clients.add(client);
    socket.on("data", (chunk: Buffer) => {
      this.consume(client, chunk);
    });
    socket.on("close", () => {
      client.closed = true;
      this.clients.delete(client);
    });
    socket.on("error", () => {
      client.closed = true;
      this.clients.delete(client);
      socket.destroy();
    });
    this.send(client, {
      type: "connected",
      projectId: client.project.id,
      cursor: client.cursor,
      occurredAt: new Date().toISOString(),
    });
    if (head.length > 0) {
      this.consume(client, Buffer.alloc(0));
    }
  }

  private consume(client: WebSocketClient, chunk: Buffer): void {
    client.input = Buffer.concat([client.input, chunk]);
    if (client.input.length > MAX_CLIENT_BUFFER) {
      this.disconnect(client, 1009, "Frame too large");
      return;
    }
    while (client.input.length >= 2) {
      const first = client.input[0];
      const second = client.input[1];
      if (first === undefined || second === undefined) {
        return;
      }
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (client.input.length < 4) {
          return;
        }
        length = client.input.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (client.input.length < 10) {
          return;
        }
        const wide = client.input.readBigUInt64BE(2);
        if (wide > BigInt(MAX_CLIENT_BUFFER)) {
          this.disconnect(client, 1009, "Frame too large");
          return;
        }
        length = Number(wide);
        offset = 10;
      }
      if (!masked || client.input.length < offset + 4 + length) {
        if (!masked) {
          this.disconnect(client, 1002, "Client frames must be masked");
        }
        return;
      }
      const mask = client.input.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(
        client.input.subarray(offset, offset + length),
      );
      for (let index = 0; index < payload.length; index += 1) {
        const maskByte = mask[index % 4];
        if (maskByte !== undefined) {
          payload[index] = (payload[index] ?? 0) ^ maskByte;
        }
      }
      client.input = client.input.subarray(offset + length);
      if (opcode === 0x8) {
        this.disconnect(client, 1000, "Closed");
        return;
      }
      if (opcode === 0x9) {
        client.socket.write(frame(0x0a, payload));
      } else if (opcode !== 0x0a && opcode !== 0x1) {
        this.disconnect(client, 1003, "Unsupported frame");
        return;
      }
    }
  }

  private async poll(): Promise<void> {
    await Promise.all(
      [...this.clients].map(async (client) => {
        if (client.closed) {
          return;
        }
        if (Date.now() >= client.nextAuthorizationAt) {
          try {
            const refreshed = await this.options.reauthorize({
              principal: client.principal,
              project: client.project,
            });
            if (client.closed) {
              return;
            }
            client.principal = refreshed.principal;
            client.project = refreshed.project;
            client.nextAuthorizationAt =
              Date.now() + this.reauthorizeIntervalMs;
          } catch {
            this.disconnect(client, 1008, "Authorization is no longer valid");
            return;
          }
        }
        try {
          const events = await this.store.listAuditEvents({
            afterSequence: client.cursor,
            limit: 500,
          });
          for (const record of events) {
            client.cursor = record.sequence;
            if (await this.visible(client, record.runId, record.event.data)) {
              this.send(client, {
                type: "audit",
                sequence: record.sequence,
                runId: record.runId,
                event: record.event,
              });
            }
          }
        } catch {
          this.disconnect(client, 1011, "Event stream failed");
        }
      }),
    );
  }

  private async visible(
    client: WebSocketClient,
    runId: string | undefined,
    data: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    if (runId === undefined) {
      return (
        data["projectId"] === client.project.id ||
        data["organizationId"] === client.project.organizationId
      );
    }
    let projectId = this.runProjects.get(runId);
    if (!this.runProjects.has(runId)) {
      projectId = (await this.store.getRun(runId))?.run.projectId;
      this.runProjects.set(runId, projectId);
    }
    return projectId === client.project.id;
  }

  private send(client: WebSocketClient, value: unknown): void {
    if (
      client.closed ||
      client.socket.destroyed ||
      client.socket.writableLength > MAX_CLIENT_BUFFER
    ) {
      this.disconnect(client, 1008, "Client is too slow");
      return;
    }
    client.socket.write(textFrame(value));
  }

  private disconnect(client: WebSocketClient, code: number, reason: string): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    this.clients.delete(client);
    if (!client.socket.destroyed) {
      client.socket.end(closeFrame(code, reason));
    }
  }
}
