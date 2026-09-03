import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_PROTOCOL_VERSION,
  McpArgumentError,
  handleMcpMessage,
  mcpRefusal,
  mcpText,
  optionalChoice,
  optionalString,
  requiredString,
  type McpTool,
} from "./mcp.js";

/** One tool that answers, and one that refuses, which is the whole surface. */
function tools(overrides: Partial<McpTool> = {}): McpTool[] {
  return [
    {
      name: "echo",
      title: "Echo",
      description: "Says back what it was given.",
      inputSchema: {
        type: "object",
        properties: { say: { type: "string" } },
        required: ["say"],
        additionalProperties: false,
      },
      async run(args) {
        return mcpText(String(args["say"]));
      },
      ...overrides,
    },
  ];
}

async function ask(payload: unknown, list: McpTool[] = tools()) {
  return await handleMcpMessage({
    payload,
    tools: list,
    serverName: "kumi",
    serverVersion: "1.0.0",
  });
}

test("initialize answers with this server's tools capability", async () => {
  const reply = await ask({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION },
  });
  assert.equal(reply.status, 200);
  const body = reply.body as {
    result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown };
  };
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.deepEqual(body.result.serverInfo, { name: "kumi", version: "1.0.0" });
});

test("initialize speaks the client's revision when it can", async () => {
  // Echoed rather than corrected: a client on an older revision this server
  // still speaks should not be told to upgrade for nothing.
  const older = await ask({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(
    (older.body as { result: { protocolVersion: string } }).result.protocolVersion,
    "2024-11-05",
  );

  // And a revision from the future gets ours, so the client can decide.
  const newer = await ask({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2099-01-01" },
  });
  assert.equal(
    (newer.body as { result: { protocolVersion: string } }).result.protocolVersion,
    MCP_PROTOCOL_VERSION,
  );
});

/**
 * The framing bug that hangs clients.
 *
 * `notifications/initialized` arrives immediately after `initialize` and has no
 * `id`. Answering it with a JSON-RPC response object — which is what a handler
 * written around "every message gets a reply" does — leaves strict clients
 * waiting for a response to a message that can never have one.
 */
test("a notification is acknowledged with no body at all", async () => {
  const reply = await ask({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.body, undefined);
});

test("a batch is refused rather than half-served", async () => {
  // Processing element zero and dropping the rest is the failure that looks
  // like the server working.
  const reply = await ask([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const body = reply.body as { id: null; error: { code: number; message: string } };
  assert.equal(body.error.code, -32600);
  assert.equal(body.id, null);
  assert.match(body.error.message, /one message at a time/u);
});

test("a message that is not JSON-RPC 2.0 is refused", async () => {
  for (const payload of [{ id: 1, method: "ping" }, "hello", 7, null]) {
    const reply = await ask(payload);
    assert.equal(
      (reply.body as { error: { code: number } }).error.code,
      -32600,
      `accepted ${JSON.stringify(payload)}`,
    );
  }
});

test("an unknown method is a protocol error", async () => {
  const reply = await ask({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  const body = reply.body as { error: { code: number; message: string } };
  assert.equal(body.error.code, -32601);
  assert.match(body.error.message, /resources\/list/u);
});

test("ping answers, because clients use it to check the connection", async () => {
  const reply = await ask({ jsonrpc: "2.0", id: 5, method: "ping" });
  assert.deepEqual(reply.body, { jsonrpc: "2.0", id: 5, result: {} });
});

test("tools/list describes every tool with its schema", async () => {
  const reply = await ask({ jsonrpc: "2.0", id: 6, method: "tools/list" });
  const listed = (reply.body as { result: { tools: Array<{ name: string; inputSchema: unknown }> } })
    .result.tools;
  assert.deepEqual(
    listed.map((tool) => tool.name),
    ["echo"],
  );
  assert.deepEqual(listed[0]?.inputSchema, {
    type: "object",
    properties: { say: { type: "string" } },
    required: ["say"],
    additionalProperties: false,
  });
});

test("tools/call runs the tool and returns its content", async () => {
  const reply = await ask({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "echo", arguments: { say: "hello" } },
  });
  assert.deepEqual(reply.body, {
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "hello" }] },
  });
});

/**
 * A tool that refuses has still been reached.
 *
 * This is the rule the offline exchange rests on: a refusal must arrive as a
 * *successful* call carrying `isError`, so the model reads the sentence and
 * acts on it. Sent as a JSON-RPC error it reads as a broken server, and the
 * model reports a transport failure instead of the choice it was offered.
 */
test("a tool that refuses returns a result, not a protocol error", async () => {
  const reply = await ask(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    },
    tools({
      async run() {
        return mcpRefusal("Nobody is listening — queue it, or pick someone else.");
      },
    }),
  );
  const body = reply.body as {
    error?: unknown;
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.error, undefined, "a refusal was sent as a protocol error");
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]?.text ?? "", /queue it/u);
});

test("a tool that throws is reported as its own failure", async () => {
  const reply = await ask(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    },
    tools({
      async run() {
        throw new McpArgumentError('"say" is required and must be text');
      },
    }),
  );
  const body = reply.body as {
    error?: unknown;
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.error, undefined);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]?.text ?? "", /"say" is required/u);
});

test("naming a tool that does not exist is a protocol error", async () => {
  const missing = await ask({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "nonesuch", arguments: {} },
  });
  assert.equal((missing.body as { error: { code: number } }).error.code, -32602);

  const unnamed = await ask({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {},
  });
  assert.equal((unnamed.body as { error: { code: number } }).error.code, -32602);

  const wrongArguments = await ask({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "echo", arguments: "hello" },
  });
  assert.equal(
    (wrongArguments.body as { error: { code: number } }).error.code,
    -32602,
  );
});

test("a call with no arguments at all reaches the tool", async () => {
  // Omitting `arguments` entirely is legal, and a tool whose fields are all
  // optional must still run.
  let seen: unknown;
  await ask(
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "echo" } },
    tools({
      async run(args) {
        seen = args;
        return mcpText("ok");
      },
    }),
  );
  assert.deepEqual(seen, {});
});

test("argument helpers accept what they should and name what they reject", () => {
  assert.equal(requiredString({ a: "  x  " }, "a"), "x");
  assert.throws(() => requiredString({}, "a"), /"a" is required/u);
  assert.throws(() => requiredString({ a: "   " }, "a"), /"a" is required/u);
  assert.throws(() => requiredString({ a: 3 }, "a"), /must be text/u);
  assert.throws(() => requiredString({ a: "abcd" }, "a", 3), /longer than 3/u);

  // Absent, null and empty all mean the same thing to a model filling in a
  // form it half-understands.
  assert.equal(optionalString({}, "a"), undefined);
  assert.equal(optionalString({ a: null }, "a"), undefined);
  assert.equal(optionalString({ a: "" }, "a"), undefined);
  assert.equal(optionalString({ a: "  " }, "a"), undefined);
  assert.equal(optionalString({ a: " y " }, "a"), "y");
  assert.throws(() => optionalString({ a: 1 }, "a"), /must be text/u);

  assert.equal(optionalChoice({ a: "queue" }, "a", ["queue", "cancel"]), "queue");
  assert.equal(optionalChoice({}, "a", ["queue", "cancel"]), undefined);
  assert.throws(
    () => optionalChoice({ a: "maybe" }, "a", ["queue", "cancel"]),
    /must be one of: queue, cancel/u,
  );
});
