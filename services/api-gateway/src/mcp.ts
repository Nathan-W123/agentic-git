/**
 * Kumi as an MCP server: the protocol half.
 *
 * ### Why this is hand-rolled
 *
 * MCP over Streamable HTTP is JSON-RPC 2.0 on one POST. The official SDK's
 * transport wants to own the session id, the `Mcp-Session-Id` header, the SSE
 * upgrade and a `DELETE` route — none of which this gateway can give it, because
 * it authenticates in `handle()` before routing and hands its routes a raw
 * `IncomingMessage`. It also hand-rolls its own WebSocket frame codec. A
 * framework here would be the only one in the process, to save three methods.
 *
 * So: `initialize`, `tools/list`, `tools/call`, `ping`, and nothing else.
 *
 * ### Why there is no SSE
 *
 * The spec lets a server answer a POST with a plain JSON body instead of a
 * stream, and this one has no chunked-response helper — `sendJson` sets
 * `Content-Length` on everything. Every tool here answers in one round trip, so
 * the stream would carry a single message.
 *
 * The cost is worth writing down: `elicitation/create`, which is how a server
 * asks the person a question mid-call, is a server-to-client *request* and needs
 * that stream. It is therefore unavailable, which is why the one place a tool
 * has to ask something — an agent whose machine is offline — is modelled as two
 * calls rather than one interactive one. See `submit_task`.
 *
 * ### The two framing rules that break clients when got wrong
 *
 * A *notification* has no `id` and must receive no response body at all.
 * `notifications/initialized` arrives immediately after `initialize`, and
 * answering it with a JSON-RPC response object hangs strict clients.
 *
 * A tool that *fails* returns a successful result carrying `isError: true`, not
 * a JSON-RPC error. JSON-RPC errors are for protocol faults — a method that does
 * not exist, arguments that are not an object. Using them for "that repository
 * is not yours" makes every ordinary refusal look like a broken server, and the
 * model stops reading the message that would have told it what to do instead.
 */

/**
 * The revision this server speaks.
 *
 * `initialize` echoes back whatever the client asked for when we can speak it,
 * and this otherwise. A client that asks for something newer gets this and is
 * free to disconnect.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Protocol faults. Never used for a tool that ran and refused. */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** What a tool hands back. Text only; no images, no embedded resources yet. */
export interface McpToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  /** True when the tool ran and could not do what was asked. */
  readonly isError?: boolean;
}

/** One tool, as `tools/list` describes it and `tools/call` runs it. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
  run(args: Readonly<Record<string, unknown>>): Promise<McpToolResult>;
}

/** What the route should send. `body` absent means an empty response. */
export interface McpReply {
  readonly status: number;
  readonly body?: unknown;
}

/** Plain text, which is what every tool here returns. */
export function mcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A refusal the model is meant to read and act on.
 *
 * Deliberately a *result* rather than a thrown error: see the header. The model
 * sees the sentence, tells the person, and often calls again with something
 * different — which is the whole mechanism behind the offline exchange.
 */
export function mcpRefusal(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Thrown by a tool when its arguments are wrong.
 *
 * Separated from a refusal because it is the caller's own fault rather than a
 * fact about the workspace, and because the model can fix it without asking
 * anybody. It still arrives as `isError`, not as a JSON-RPC error, so the
 * message reaches the model rather than the transport.
 */
export class McpArgumentError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required string argument, trimmed, non-empty. */
export function requiredString(
  args: Readonly<Record<string, unknown>>,
  name: string,
  max = 10_000,
): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpArgumentError(`"${name}" is required and must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new McpArgumentError(`"${name}" is longer than ${max} characters`);
  }
  return trimmed;
}

/** An optional string argument. Absent, null and empty all read as absent. */
export function optionalString(
  args: Readonly<Record<string, unknown>>,
  name: string,
  max = 10_000,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new McpArgumentError(`"${name}" must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > max) {
    throw new McpArgumentError(`"${name}" is longer than ${max} characters`);
  }
  return trimmed;
}

/** An optional argument that has to be one of a fixed set. */
export function optionalChoice<T extends string>(
  args: Readonly<Record<string, unknown>>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new McpArgumentError(
      `"${name}" must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): McpReply {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
  };
}

function jsonRpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

/**
 * Answers one JSON-RPC message.
 *
 * `payload` is whatever the body parsed to; a parse failure is the route's to
 * report, because it has the request and this does not.
 */
export async function handleMcpMessage(input: {
  readonly payload: unknown;
  readonly tools: readonly McpTool[];
  readonly serverName: string;
  readonly serverVersion: string;
}): Promise<McpReply> {
  const { payload, tools } = input;

  // A batch. The spec allows one and nothing here needs it, so it is refused
  // rather than half-served: processing element zero and dropping the rest is
  // the failure that looks like the server working.
  if (Array.isArray(payload)) {
    return jsonRpcError(
      null,
      INVALID_REQUEST,
      "This server does not accept batched requests; send one message at a time",
    );
  }
  if (!isObject(payload) || payload["jsonrpc"] !== "2.0") {
    return jsonRpcError(
      isObject(payload) ? payload["id"] : null,
      INVALID_REQUEST,
      "Expected a JSON-RPC 2.0 message",
    );
  }

  const method = payload["method"];
  if (typeof method !== "string") {
    return jsonRpcError(payload["id"], INVALID_REQUEST, "No method named");
  }

  // A notification, which by definition carries no id and gets no answer. The
  // one that matters is `notifications/initialized`; answering it with a
  // response object is the single most common way to hang a client.
  if (!("id" in payload)) {
    return { status: 202 };
  }
  const id = payload["id"];

  if (method === "initialize") {
    const params = isObject(payload["params"]) ? payload["params"] : {};
    const asked = params["protocolVersion"];
    return jsonRpcResult(id, {
      // Echoed when we can speak it, so a client on an older revision is not
      // told to upgrade for no reason.
      protocolVersion:
        typeof asked === "string" && asked <= MCP_PROTOCOL_VERSION
          ? asked
          : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: input.serverName, version: input.serverVersion },
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const params = isObject(payload["params"]) ? payload["params"] : undefined;
    const name = params?.["name"];
    if (typeof name !== "string") {
      return jsonRpcError(id, INVALID_PARAMS, "No tool named");
    }
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) {
      return jsonRpcError(id, INVALID_PARAMS, `No tool called "${name}"`);
    }
    const rawArguments = params?.["arguments"];
    if (rawArguments !== undefined && !isObject(rawArguments)) {
      return jsonRpcError(id, INVALID_PARAMS, "Tool arguments must be an object");
    }
    // Everything from here is the tool's own answer, including its failures.
    // A tool that throws has still been reached, and the model needs to read
    // why rather than be told the transport broke.
    try {
      return jsonRpcResult(id, await tool.run(rawArguments ?? {}));
    } catch (error) {
      return jsonRpcResult(
        id,
        mcpRefusal(
          error instanceof Error ? error.message : "The tool could not run",
        ),
      );
    }
  }

  return jsonRpcError(id, METHOD_NOT_FOUND, `Unknown method "${method}"`);
}
