import type { AgentActionResult, AgentEvent } from "@coord/agent-protocol";
import {
  assertAgentPlan,
  type AgentPlan,
  type CanonicalVersion,
  type CoordinatorDecision,
  type ReplanRequest,
  type ScopeChangeDecision,
  type ValidationCommand,
} from "@coord/shared-types";

/**
 * Newline-delimited JSON framing for command-line coding agents.
 *
 * The host writes one {@link HostMessage} per line to the child's stdin and
 * reads one {@link AgentMessage} per line from its stdout. Anything the agent
 * writes to stderr is diagnostic output and never carries protocol meaning.
 */

/** Guards against an agent that streams unbounded output without a newline. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class AgentProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export interface StartMessage {
  type: "start";
  sessionId: string;
  taskId: string;
  objective: string;
  repositoryId: string;
  canonicalVersion: CanonicalVersion;
  validationCommands: ValidationCommand[];
  /** Disposable canonical workspace available during planning. */
  workspacePath?: string;
}

export interface PlanRequestMessage {
  type: "plan_request";
  sessionId: string;
}

export interface ReplanRequestMessage {
  type: "replan_request";
  sessionId: string;
  request: ReplanRequest;
  workspacePath?: string;
}

export interface ContextMessage {
  type: "context";
  sessionId: string;
  /** Workspace path as the agent process sees it, not necessarily the host path. */
  workspacePath: string;
  decision: CoordinatorDecision;
  canonicalVersion: CanonicalVersion;
  plan: AgentPlan;
  planRevision?: number;
}

export interface ControlMessage {
  type: "pause" | "resume" | "cancel";
  sessionId: string;
}

export interface ScopeDecisionMessage {
  type: "scope_decision";
  sessionId: string;
  decision: ScopeChangeDecision;
}

/** The answer to an `action_requested` event. */
export interface ActionResultMessage {
  type: "action_result";
  sessionId: string;
  result: AgentActionResult;
}

export type HostMessage =
  | StartMessage
  | PlanRequestMessage
  | ReplanRequestMessage
  | ContextMessage
  | ScopeDecisionMessage
  | ActionResultMessage
  | ControlMessage;

export interface PlanReplyMessage {
  type: "plan";
  plan: AgentPlan;
}

export interface EventMessage {
  type: "event";
  event: AgentEvent;
}

export interface DoneMessage {
  type: "done";
  symbolsChanged: string[];
  explanation: string;
  /**
   * What the run cost, if the agent knows.
   *
   * Optional and never inferred: an agent that reports nothing is recorded as
   * having reported nothing, because a budget enforced against an invented
   * figure would be worse than one enforced against a gap in the data.
   */
  tokens?: { total: number; input?: number; output?: number };
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type AgentMessage =
  | PlanReplyMessage
  | EventMessage
  | DoneMessage
  | ErrorMessage;

export type AgentMessageType = AgentMessage["type"];

export function encodeHostMessage(message: HostMessage): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) {
    throw new AgentProtocolError("Host message framing produced an embedded newline");
  }
  return `${line}\n`;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Splits a byte stream into complete lines, tolerating chunk boundaries that
 * fall inside a message and CRLF endings from Windows child processes.
 */
export class JsonLineDecoder {
  private buffer = "";

  public push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];

    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      lines.push(stripCarriageReturn(this.buffer.slice(0, index)));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }

    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.buffer = "";
      throw new AgentProtocolError(
        `Agent emitted more than ${MAX_MESSAGE_BYTES} bytes without a newline`,
      );
    }

    return lines.filter((line) => line.trim().length > 0);
  }

  /** Returns any trailing content the agent left without a final newline. */
  public flush(): string[] {
    const remainder = stripCarriageReturn(this.buffer);
    this.buffer = "";
    return remainder.trim().length > 0 ? [remainder] : [];
  }
}

function truncate(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function asRecord(value: unknown, line: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentProtocolError(
      `Agent message must be a JSON object: ${truncate(line)}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  messageType: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new AgentProtocolError(
      `Agent "${messageType}" message requires a string "${key}"`,
    );
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  messageType: string,
): string[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new AgentProtocolError(
      `Agent "${messageType}" message requires "${key}" to be an array of strings`,
    );
  }
  return [...(value as string[])];
}

/**
 * Reads an optional token report off a `done` message.
 *
 * Anything unusable — a missing total, a negative figure, a non-object —
 * yields undefined rather than throwing. A miscounted bill must not fail a
 * run whose code is fine; it is recorded as unreported, and a project with a
 * token budget sees the gap instead of a wrong number.
 */
function parseTokenReport(
  value: unknown,
): { total: number; input?: number; output?: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const count = (key: string): number | undefined => {
    const entry = record[key];
    return typeof entry === "number" &&
      Number.isSafeInteger(entry) &&
      entry >= 0
      ? entry
      : undefined;
  };
  const total = count("total");
  if (total === undefined) {
    return undefined;
  }
  const input = count("input");
  const output = count("output");
  return {
    total,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

export function parseAgentEvent(value: unknown): AgentEvent {
  const record = asRecord(value, JSON.stringify(value ?? null));
  const occurredAt =
    typeof record["occurredAt"] === "string"
      ? record["occurredAt"]
      : new Date().toISOString();

  switch (record["event"]) {
    case "progress":
      return {
        event: "progress",
        message: requireString(record, "message", "progress event"),
        occurredAt,
      };
    case "scope_change_requested":
      return {
        event: "scope_change_requested",
        ...(typeof record["requestId"] === "string"
          ? { requestId: record["requestId"] }
          : {}),
        additionalFiles: optionalStringArray(
          record,
          "additionalFiles",
          "scope change event",
        ),
        ...(record["additionalSymbols"] === undefined
          ? {}
          : {
              additionalSymbols: optionalStringArray(
                record,
                "additionalSymbols",
                "scope change event",
              ),
            }),
        ...(record["additionalApis"] === undefined
          ? {}
          : {
              additionalApis: optionalStringArray(
                record,
                "additionalApis",
                "scope change event",
              ),
            }),
        ...(record["additionalSchemas"] === undefined
          ? {}
          : {
              additionalSchemas: optionalStringArray(
                record,
                "additionalSchemas",
                "scope change event",
              ),
            }),
        ...(record["additionalConfigKeys"] === undefined
          ? {}
          : {
              additionalConfigKeys: optionalStringArray(
                record,
                "additionalConfigKeys",
                "scope change event",
              ),
            }),
        ...(record["additionalTests"] === undefined
          ? {}
          : {
              additionalTests: optionalStringArray(
                record,
                "additionalTests",
                "scope change event",
              ),
            }),
        ...(record["additionalServices"] === undefined
          ? {}
          : {
              additionalServices: optionalStringArray(
                record,
                "additionalServices",
                "scope change event",
              ),
            }),
        reason: requireString(record, "reason", "scope change event"),
        occurredAt,
      };
    case "replan_proposed": {
      const proposed: unknown = record["plan"];
      assertAgentPlan(proposed);
      return {
        event: "replan_proposed",
        ...(typeof record["requestId"] === "string"
          ? { requestId: record["requestId"] }
          : {}),
        plan: proposed,
        reason: requireString(record, "reason", "replan proposal"),
        occurredAt,
      };
    }
    case "action_requested":
      return {
        event: "action_requested",
        ...(typeof record["requestId"] === "string"
          ? { requestId: record["requestId"] }
          : {}),
        action: requireString(record, "action", "action request"),
        occurredAt,
      };
    case "completed":
      return { event: "completed", occurredAt };
    default:
      throw new AgentProtocolError(
        `Unknown agent event: ${String(record["event"])}`,
      );
  }
}

export function parseAgentMessage(line: string): AgentMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new AgentProtocolError(
      `Agent emitted a line that is not valid JSON: ${truncate(line)}`,
    );
  }

  const record = asRecord(decoded, line);
  switch (record["type"]) {
    case "plan": {
      const plan: unknown = record["plan"];
      assertAgentPlan(plan);
      return { type: "plan", plan };
    }
    case "event":
      return { type: "event", event: parseAgentEvent(record["event"]) };
    case "done":
      return {
        type: "done",
        symbolsChanged: optionalStringArray(record, "symbolsChanged", "done"),
        explanation:
          typeof record["explanation"] === "string" ? record["explanation"] : "",
        ...(parseTokenReport(record["tokens"]) === undefined
          ? {}
          : { tokens: parseTokenReport(record["tokens"])! }),
      };
    case "error":
      return {
        type: "error",
        message: requireString(record, "message", "error"),
      };
    default:
      throw new AgentProtocolError(
        `Unknown agent message type: ${String(record["type"])}`,
      );
  }
}
