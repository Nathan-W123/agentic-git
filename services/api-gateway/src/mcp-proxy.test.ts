import assert from "node:assert/strict";
import test from "node:test";

import { McpDialError } from "./mcp-dialer.js";
import {
  callProxiedTool,
  MANIFEST_FAILURE_TTL_MS,
  MANIFEST_TTL_MS,
  MAX_TOOLS_PER_SERVER,
  McpManifestCache,
  proxiedTools,
  proxyToolName,
  sanitiseNamePart,
  toolsFromManifest,
  type ProxyDial,
  type ProxyTarget,
} from "./mcp-proxy.js";

function target(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    serverId: "mcp_1",
    serverName: "linear",
    projectId: "project_a",
    url: "https://tools.example.com/mcp",
    headers: { authorization: "Bearer secret" },
    revision: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A manifest reply naming these tools, in the shape a real server sends. */
function manifest(...names: string[]): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: names.map((name) => ({
        name,
        description: `does ${name}`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      })),
    },
  };
}

test("a tool name is namespaced by its server and safe to type back", () => {
  assert.equal(proxyToolName("Linear", "list_issues"), "linear__list_issues");
  // Both halves are reduced to what an MCP client will accept as an
  // identifier. A model has to be able to echo the name back exactly.
  assert.equal(
    proxyToolName("Linear Issues", "list.issues"),
    "linear-issues__list-issues",
  );
  assert.match(proxyToolName("Linear Issues", "list.issues") ?? "", /^[a-z0-9_-]+$/u);
  assert.equal(sanitiseNamePart("--trim--"), "trim");
  // Nothing survives sanitising, so there is no name to offer. Answering
  // with a bare separator would put an uncallable tool in the list.
  assert.equal(proxyToolName("!!!", "list"), undefined);
  assert.equal(proxyToolName("linear", "***"), undefined);
});

test("a malformed entry costs its own tool and no others", () => {
  const { tools } = toolsFromManifest(
    {
      result: {
        tools: [
          { name: "good" },
          null,
          { description: "no name at all" },
          { name: "" },
          { name: "also_good", inputSchema: { type: "object" } },
        ],
      },
    },
    target(),
  );
  // The reply comes from a server this deployment does not control, so one
  // bad entry must not cost a project every other tool that server offers.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["linear__good", "linear__also_good"],
  );
  // A tool with no schema at all is uncallable by most clients, so the
  // permissive one stands in.
  assert.deepEqual(tools[0]?.inputSchema, {
    type: "object",
    additionalProperties: true,
  });
});

test("a reply that is not a manifest yields nothing rather than throwing", () => {
  for (const reply of [undefined, null, 42, {}, { result: {} }, { result: { tools: "no" } }]) {
    assert.deepEqual(toolsFromManifest(reply, target()).tools, []);
  }
});

test("one server cannot flood a turn with tools", () => {
  const names = Array.from({ length: MAX_TOOLS_PER_SERVER + 5 }, (_x, index) =>
    `tool_${index}`,
  );
  const { tools, dropped } = toolsFromManifest(
    { result: { tools: names.map((name) => ({ name })) } },
    target(),
  );
  // Schemas are sent on every turn and charged to the task's budget, so the
  // cap is real; and it is reported rather than silent.
  assert.equal(tools.length, MAX_TOOLS_PER_SERVER);
  assert.equal(dropped, 5);
});

test("a manifest is dialled once and then remembered", async () => {
  let dials = 0;
  const dial: ProxyDial = async () => {
    dials += 1;
    return manifest("list_issues");
  };
  let clock = 1_000;
  const cache = new McpManifestCache(() => clock);

  assert.equal((await cache.tools(target(), dial)).tools.length, 1);
  assert.equal((await cache.tools(target(), dial)).tools.length, 1);
  assert.equal(dials, 1, "dialled again for a hit");

  // `tools/list` runs on every editor handshake. Without the cache, three
  // approved servers put three round trips to somebody else's infrastructure
  // in front of every session.
  clock += MANIFEST_TTL_MS + 1;
  await cache.tools(target(), dial);
  assert.equal(dials, 2);
});

test("an edit to the row invalidates what was remembered about it", async () => {
  let dials = 0;
  const dial: ProxyDial = async () => {
    dials += 1;
    return manifest("list_issues");
  };
  const cache = new McpManifestCache(() => 1_000);
  await cache.tools(target(), dial);
  await cache.tools(target({ revision: "2026-02-02T00:00:00.000Z" }), dial);
  // An admin who changes a server's URL should not wait out the TTL to see
  // the tools the new one offers.
  assert.equal(dials, 2);
  // This is the whole of invalidation. A withdrawn approval and a changed
  // URL both move `updatedAt`, so both land here rather than needing a
  // separate "forget this one" that a route has to remember to call.
});

test("concurrent handshakes share one dial rather than each opening theirs", async () => {
  // Every waiting dial is held and then released, rather than only the last
  // one: a version of this that keeps a single resolver would deadlock under
  // the very fault it exists to catch, and a hang is not a test result.
  const waiting: Array<() => void> = [];
  const dial: ProxyDial = async () => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
    return manifest("list_issues");
  };
  const cache = new McpManifestCache(() => 1_000);
  const both = Promise.all([
    cache.tools(target(), dial),
    cache.tools(target(), dial),
  ]);
  // Given a moment for both callers to reach the dial before it answers.
  await new Promise((resolve) => setImmediate(resolve));
  const dials = waiting.length;
  for (const release of waiting) {
    release();
  }
  const [first, second] = await both;
  assert.equal(dials, 1, "each handshake opened its own dial");
  assert.equal(first?.tools.length, 1);
  assert.equal(second?.tools.length, 1);
});

test("a server that is down is remembered as down, briefly", async () => {
  let dials = 0;
  const dial: ProxyDial = async () => {
    dials += 1;
    throw new McpDialError("The server answered 503.", "http_status");
  };
  let clock = 1_000;
  const cache = new McpManifestCache(() => clock);

  const failed = await cache.tools(target(), dial);
  assert.deepEqual(failed.tools, []);
  assert.match(failed.failure ?? "", /503/u);
  await cache.tools(target(), dial);
  // Paying the dial timeout again on the very next handshake is the thing
  // this avoids.
  assert.equal(dials, 1);

  // And briefly, so a server that comes back is not invisible for the full
  // five minutes a success is believed for.
  clock += MANIFEST_FAILURE_TTL_MS + 1;
  await cache.tools(target(), dial);
  assert.equal(dials, 2);
  assert.ok(MANIFEST_FAILURE_TTL_MS < MANIFEST_TTL_MS);
});

test("two servers sharing a name do not rename each other's tools", async () => {
  const dial: ProxyDial = async (input) =>
    input.url.includes("first") ? manifest("search") : manifest("search", "other");
  const cache = new McpManifestCache(() => 1_000);
  const { tools } = await proxiedTools(
    [
      target({
        serverId: "mcp_b",
        projectId: "project_b",
        url: "https://second.example.com/mcp",
      }),
      target({
        serverId: "mcp_a",
        projectId: "project_a",
        url: "https://first.example.com/mcp",
      }),
    ],
    dial,
    cache,
  );
  // Deterministic by project then server, whichever order they arrived in,
  // and the loser's colliding tool is dropped rather than renamed: a tool
  // whose name changes when somebody else's project adds a server would
  // break a conversation already in progress.
  assert.deepEqual(
    tools.map((tool) => `${tool.serverId}:${tool.name}`),
    ["mcp_a:linear__search", "mcp_b:linear__other"],
  );
});

test("one unreachable server does not take the others' tools with it", async () => {
  const dial: ProxyDial = async (input) => {
    if (input.url.includes("broken")) {
      throw new McpDialError("The server did not answer within 6s.", "timeout");
    }
    return manifest("search");
  };
  const { tools, failures } = await proxiedTools(
    [
      target({ serverId: "mcp_ok", serverName: "docs" }),
      target({
        serverId: "mcp_bad",
        serverName: "broken",
        url: "https://broken.example.com/mcp",
      }),
    ],
    dial,
    new McpManifestCache(() => 1_000),
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["docs__search"],
  );
  assert.deepEqual(
    failures.map((entry) => entry.server),
    ["broken"],
  );
});

test("a call is relayed under the name the far end knows", async () => {
  const sent: unknown[] = [];
  const dial: ProxyDial = async (input) => {
    sent.push(input.body);
    return { result: { content: [{ type: "text", text: "two issues" }] } };
  };
  const answer = await callProxiedTool({
    tool: {
      name: "linear__list_issues",
      remoteName: "list_issues",
      serverId: "mcp_1",
      serverName: "linear",
      projectId: "project_a",
      description: "",
      inputSchema: {},
    },
    target: target(),
    args: { q: "open" },
    dial,
  });
  assert.deepEqual(answer.content, [{ type: "text", text: "two issues" }]);
  assert.equal(answer.isError, undefined);
  // The namespaced name is Kumi's; the far end has never heard of it.
  assert.deepEqual(sent, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_issues", arguments: { q: "open" } },
    },
  ]);
});

test("every way a call can go wrong comes back as a readable tool result", async () => {
  const tool = {
    name: "linear__list_issues",
    remoteName: "list_issues",
    serverId: "mcp_1",
    serverName: "linear",
    projectId: "project_a",
    description: "",
    inputSchema: {},
  };
  const cases: Array<[ProxyDial, RegExp]> = [
    [
      async () => {
        throw new McpDialError("The server answered 503.", "http_status");
      },
      /could not be reached.*503/u,
    ],
    [
      async () => ({ error: { code: -32602, message: "unknown argument" } }),
      /refused: unknown argument/u,
    ],
    [async () => "not an envelope at all", /shape Kumi could not read/u],
  ];
  for (const [dial, expected] of cases) {
    const answer = await callProxiedTool({
      tool,
      target: target(),
      args: {},
      dial,
    });
    // A refusal has to be readable text, because the person is in an editor
    // and cannot go and look at anything.
    assert.equal(answer.isError, true);
    assert.match(String(answer.content[0]?.text), expected);
  }

  // The far end's own `isError` is relayed rather than overwritten: this is
  // its answer about its own tool.
  const refused = await callProxiedTool({
    tool,
    target: target(),
    args: {},
    dial: async () => ({
      result: { content: [{ type: "text", text: "no such issue" }], isError: true },
    }),
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0]?.text, "no such issue");

  // A result with no content block is legal and means it worked.
  const quiet = await callProxiedTool({
    tool,
    target: target(),
    args: {},
    dial: async () => ({ result: {} }),
  });
  assert.equal(quiet.isError, undefined);
  assert.match(String(quiet.content[0]?.text), /ran list_issues/u);
});
