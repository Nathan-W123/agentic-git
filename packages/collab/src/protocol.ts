/**
 * The collaboration socket's wire format.
 *
 * Both directions are JSON text frames. Everything arriving from a browser is
 * parsed through the `parseClientMessage` guard below — the hub never reads a
 * field off an unvalidated object, because a malformed revision or component
 * array reaches the transform engine directly.
 */

import {
  parseOperation,
  CollabError,
  type OperationComponent,
  type SelectionRange,
  type TextOperation,
} from "./text-operation.js";
import type { AgentActivity, Participant } from "./room.js";

/** Longest path the socket will address, matching the HTTP workspace routes. */
export const MAX_PATH_LENGTH = 1_000;

// ---- client -> server -------------------------------------------------------

export interface ClientOperationMessage {
  readonly type: "op";
  readonly revision: number;
  readonly operation: TextOperation;
  readonly selection?: SelectionRange;
}

export interface ClientSelectionMessage {
  readonly type: "selection";
  readonly revision: number;
  readonly selection: SelectionRange;
}

/** Flushes the shared document into the owner's overlay worktree. */
export interface ClientSaveMessage {
  readonly type: "save";
}

/** Asks for a fresh snapshot after the client lost track of the revision. */
export interface ClientResyncMessage {
  readonly type: "resync";
}

export type ClientMessage =
  | ClientOperationMessage
  | ClientSelectionMessage
  | ClientSaveMessage
  | ClientResyncMessage;

// ---- server -> client -------------------------------------------------------

export interface ServerWelcomeMessage {
  readonly type: "welcome";
  readonly participantId: string;
  readonly revision: number;
  readonly content: string;
  readonly participants: readonly Participant[];
  readonly agents: readonly AgentActivity[];
  readonly ownerUserId: string;
  readonly path: string;
  /** False for a guest, who may watch but not write another user's overlay. */
  readonly writable: boolean;
  readonly dirty: boolean;
}

export interface ServerAckMessage {
  readonly type: "ack";
  readonly revision: number;
}

export interface ServerOperationMessage {
  readonly type: "op";
  readonly revision: number;
  readonly operation: readonly OperationComponent[];
  readonly participantId: string;
}

export interface ServerSelectionMessage {
  readonly type: "selection";
  readonly participantId: string;
  readonly selection: SelectionRange;
}

export interface ServerJoinMessage {
  readonly type: "join";
  readonly participant: Participant;
}

export interface ServerLeaveMessage {
  readonly type: "leave";
  readonly participantId: string;
}

export interface ServerSavedMessage {
  readonly type: "saved";
  readonly revision: number;
  readonly savedBy: string;
}

export interface ServerAgentsMessage {
  readonly type: "agents";
  readonly agents: readonly AgentActivity[];
}

export interface ServerErrorMessage {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  /** A fatal error means the client must resynchronize or reconnect. */
  readonly fatal: boolean;
}

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerAckMessage
  | ServerOperationMessage
  | ServerSelectionMessage
  | ServerJoinMessage
  | ServerLeaveMessage
  | ServerSavedMessage
  | ServerAgentsMessage
  | ServerErrorMessage;

// ---- parsing ----------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollabError("invalid_message", "Message must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function asRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CollabError(
      "invalid_message",
      "revision must be a non-negative integer",
    );
  }
  return value as number;
}

function asSelection(value: unknown): SelectionRange {
  const record = asRecord(value);
  const anchor = record["anchor"];
  const head = record["head"];
  if (
    !Number.isSafeInteger(anchor) ||
    !Number.isSafeInteger(head) ||
    (anchor as number) < 0 ||
    (head as number) < 0
  ) {
    throw new CollabError(
      "invalid_message",
      "selection offsets must be non-negative integers",
    );
  }
  return { anchor: anchor as number, head: head as number };
}

export function parseClientMessage(raw: string): ClientMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CollabError("invalid_message", "Message is not valid JSON");
  }
  const record = asRecord(decoded);
  switch (record["type"]) {
    case "op": {
      const selection = record["selection"];
      return {
        type: "op",
        revision: asRevision(record["revision"]),
        operation: parseOperation(record["operation"]),
        ...(selection === undefined
          ? {}
          : { selection: asSelection(selection) }),
      };
    }
    case "selection":
      return {
        type: "selection",
        revision: asRevision(record["revision"]),
        selection: asSelection(record["selection"]),
      };
    case "save":
      return { type: "save" };
    case "resync":
      return { type: "resync" };
    default:
      throw new CollabError("invalid_message", "Unknown message type");
  }
}
