/**
 * RFC 6455 framing, split out so more than one endpoint can speak WebSocket
 * without pulling in a dependency.
 *
 * The audit stream only ever pushes, so it decodes just enough to honour
 * pings and closes. The collaboration socket is bidirectional and needs real
 * frame reassembly — including continuation frames, which a browser will send
 * for a large paste. That is what `FrameReader` provides.
 */

import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
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

export function encodeTextFrame(value: unknown): Buffer {
  return encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value), "utf8"));
}

export function encodeCloseFrame(code: number, reason: string): Buffer {
  const message = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + message.length);
  payload.writeUInt16BE(code, 0);
  message.copy(payload, 2);
  return encodeFrame(OPCODE_CLOSE, payload);
}

/** Ends a socket before the handshake completes, with a plain HTTP response. */
export function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
): void {
  const body = Buffer.from(message, "utf8");
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n` +
      message,
  );
}

export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`, "ascii")
    .digest("base64");
}

/** True when the request carries a usable RFC 6455 client handshake. */
export function isWebSocketHandshake(headers: {
  upgrade?: string | undefined;
  version?: string | string[] | undefined;
  key?: string | string[] | undefined;
}): headers is { upgrade: string; version: string; key: string } {
  return (
    headers.upgrade?.toLowerCase() === "websocket" &&
    headers.version === "13" &&
    typeof headers.key === "string" &&
    headers.key.length <= 128 &&
    Buffer.from(headers.key, "base64").byteLength === 16
  );
}

export type FrameEvent =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "ping"; readonly payload: Buffer }
  | { readonly kind: "pong" }
  | { readonly kind: "close" }
  /** A protocol violation. The caller must close with `code`. */
  | { readonly kind: "fault"; readonly code: number; readonly reason: string };

export interface FrameReaderOptions {
  /** Largest single message, after reassembling continuation frames. */
  readonly maxMessageBytes: number;
  /** Largest amount of unparsed input to hold before giving up. */
  readonly maxBufferBytes: number;
}

/**
 * Incremental decoder for one client connection.
 *
 * Client frames must be masked (RFC 6455 §5.1); an unmasked frame is a
 * protocol error rather than something to tolerate, because accepting it
 * would let a naive intermediary inject frames. Binary frames are refused
 * outright: the protocol is JSON text, and refusing is cheaper than deciding
 * what a binary payload could have meant.
 */
export class FrameReader {
  private input: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | undefined;

  public constructor(private readonly options: FrameReaderOptions) {}

  public push(chunk: Buffer): FrameEvent[] {
    this.input = this.input.length === 0 ? chunk : Buffer.concat([this.input, chunk]);
    if (this.input.length > this.options.maxBufferBytes) {
      return [{ kind: "fault", code: 1009, reason: "Frame too large" }];
    }
    const events: FrameEvent[] = [];
    for (;;) {
      const event = this.readFrame(events);
      if (event === "incomplete") {
        return events;
      }
      if (event === "faulted") {
        return events;
      }
    }
  }

  /** Reads one frame, appending to `events`. */
  private readFrame(events: FrameEvent[]): "read" | "incomplete" | "faulted" {
    if (this.input.length < 2) {
      return "incomplete";
    }
    const first = this.input[0];
    const second = this.input[1];
    if (first === undefined || second === undefined) {
      return "incomplete";
    }
    const final = (first & 0x80) !== 0;
    const reserved = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (reserved !== 0) {
      events.push({ kind: "fault", code: 1002, reason: "Reserved bits set" });
      return "faulted";
    }
    if (length === 126) {
      if (this.input.length < 4) {
        return "incomplete";
      }
      length = this.input.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.input.length < 10) {
        return "incomplete";
      }
      const wide = this.input.readBigUInt64BE(2);
      if (wide > BigInt(this.options.maxMessageBytes)) {
        events.push({ kind: "fault", code: 1009, reason: "Frame too large" });
        return "faulted";
      }
      length = Number(wide);
      offset = 10;
    }
    if (!masked) {
      events.push({
        kind: "fault",
        code: 1002,
        reason: "Client frames must be masked",
      });
      return "faulted";
    }
    if (length > this.options.maxMessageBytes) {
      events.push({ kind: "fault", code: 1009, reason: "Frame too large" });
      return "faulted";
    }
    if (this.input.length < offset + 4 + length) {
      return "incomplete";
    }
    const mask = this.input.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.input.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) {
      const maskByte = mask[index % 4];
      if (maskByte !== undefined) {
        payload[index] = (payload[index] ?? 0) ^ maskByte;
      }
    }
    this.input = this.input.subarray(offset + length);

    // Control frames may be injected between fragments and are never split.
    if (opcode === OPCODE_CLOSE) {
      events.push({ kind: "close" });
      return "faulted";
    }
    if (opcode === OPCODE_PING) {
      if (!final) {
        events.push({
          kind: "fault",
          code: 1002,
          reason: "Control frames cannot be fragmented",
        });
        return "faulted";
      }
      events.push({ kind: "ping", payload });
      return "read";
    }
    if (opcode === OPCODE_PONG) {
      events.push({ kind: "pong" });
      return "read";
    }
    if (opcode === OPCODE_BINARY) {
      events.push({
        kind: "fault",
        code: 1003,
        reason: "Binary frames are not accepted",
      });
      return "faulted";
    }
    if (opcode !== OPCODE_TEXT && opcode !== OPCODE_CONTINUATION) {
      events.push({ kind: "fault", code: 1003, reason: "Unsupported frame" });
      return "faulted";
    }
    if (opcode === OPCODE_CONTINUATION && this.fragmentOpcode === undefined) {
      events.push({
        kind: "fault",
        code: 1002,
        reason: "Continuation without a start frame",
      });
      return "faulted";
    }
    if (opcode === OPCODE_TEXT && this.fragmentOpcode !== undefined) {
      events.push({
        kind: "fault",
        code: 1002,
        reason: "A new message started before the previous one finished",
      });
      return "faulted";
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.options.maxMessageBytes) {
      events.push({ kind: "fault", code: 1009, reason: "Message too large" });
      return "faulted";
    }
    this.fragments.push(payload);
    this.fragmentOpcode = opcode === OPCODE_TEXT ? OPCODE_TEXT : this.fragmentOpcode;
    if (!final) {
      return "read";
    }
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = undefined;
    events.push({ kind: "text", data: message.toString("utf8") });
    return "read";
  }
}
