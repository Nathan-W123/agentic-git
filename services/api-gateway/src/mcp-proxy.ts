/**
 * The project's approved MCP servers, re-offered to an editor as Kumi's own
 * tools.
 *
 * ### What this is for
 *
 * A project admin approves Linear, or a documentation server, and every agent
 * Kumi starts on a teammate's laptop gets it. The person sitting in Cursor got
 * nothing: they would have to add the same server to their own config, with
 * their own copy of the API key, and keep it in step by hand. That is exactly
 * the per-machine configuration this feature exists to remove.
 *
 * So an approved server can be re-offered through the endpoint the editor is
 * already connected to. Kumi lists its tools under a namespaced name, and a
 * call is relayed to the far end by {@link dialMcp} with the project's own
 * secrets attached. The editor never sees the key.
 *
 * ### Three limits, all deliberate
 *
 * - **HTTP servers only.** A `stdio` server is a process, and the control
 *   plane starting processes chosen by a project admin is the one thing this
 *   architecture has consistently refused. Those stay where they are: on the
 *   machine that consented to run them, beside an agent, under a lease.
 * - **A second opt-in per server.** `enabled` says a server may run on a
 *   teammate's laptop after that machine agrees. This says the control plane
 *   itself will dial it, with the project's secrets, for whoever is typing.
 *   Different blast radius, so a different switch — `editorEnabled`.
 * - **The manifest is cached.** `tools/list` runs on every editor handshake,
 *   and dialling three servers on each one would put six seconds of somebody
 *   else's latency in front of every session. A failure is cached too, more
 *   briefly, so one dead server does not cost the handshake its deadline over
 *   and over.
 */

import { McpDialError } from "./mcp-dialer.js";
import { mcpText, type McpToolResult } from "./mcp.js";

/** How long a server's tool list is believed. */
export const MANIFEST_TTL_MS = 5 * 60 * 1000;

/**
 * How long a *failure* is believed.
 *
 * Shorter, because a server that has just come back should not stay invisible
 * for five minutes, and longer than zero because the alternative is paying the
 * dial timeout again on the very next handshake.
 */
export const MANIFEST_FAILURE_TTL_MS = 60 * 1000;

/**
 * The deadline for a manifest dial, well under the dialer's own.
 *
 * A tool call is somebody waiting on an answer they asked for; a manifest
 * fetch is bookkeeping in front of a handshake nobody asked to be slow. The
 * two should not wait the same amount of time.
 */
export const MANIFEST_TIMEOUT_MS = 6_000;

/** The most tools one server may contribute, so a manifest cannot flood a turn. */
export const MAX_TOOLS_PER_SERVER = 60;

/** The separator between a server's name and one of its tools. */
export const PROXY_SEPARATOR = "__";

/** One tool of one approved server, as Kumi offers it. */
export interface ProxiedTool {
  /** The namespaced name an editor calls. */
  readonly name: string;
  /** The name the far end knows it by. */
  readonly remoteName: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly projectId: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** What the proxy needs to reach one server. Secrets are opened by the caller. */
export interface ProxyTarget {
  readonly serverId: string;
  readonly serverName: string;
  readonly projectId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Changes whenever the row does, so an edit invalidates the manifest. */
  readonly revision: string;
}

/** The dial, as this module needs it. Swapped in tests. */
export type ProxyDial = (input: {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: {
    readonly jsonrpc: "2.0";
    readonly id: number | string;
    readonly method: string;
    readonly params?: unknown;
  };
  timeoutMs?: number;
}) => Promise<unknown>;

/**
 * Makes a name safe to put in a tool list, and recognisable afterwards.
 *
 * MCP clients treat a tool name as an identifier, and several refuse anything
 * outside `[A-Za-z0-9_-]`. Both halves are reduced to that, so a server called
 * `Linear Issues` and a tool called `list.issues` still produce something a
 * model can type back exactly.
 */
export function sanitiseNamePart(value: string): string {
  return value
    .trim()
    .replaceAll(/[^A-Za-z0-9_-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);
}

/** `linear__list_issues`. Empty when either half sanitises away to nothing. */
export function proxyToolName(
  serverName: string,
  remoteName: string,
): string | undefined {
  const server = sanitiseNamePart(serverName).toLowerCase();
  const tool = sanitiseNamePart(remoteName);
  return server === "" || tool === ""
    ? undefined
    : `${server}${PROXY_SEPARATOR}${tool}`;
}

/**
 * Reads a manifest reply into tools, dropping anything malformed.
 *
 * Dropped rather than thrown on, because the reply comes from a server this
 * deployment does not control: one entry without a name must not cost a
 * project every other tool that server offers.
 */
export function toolsFromManifest(
  reply: unknown,
  target: ProxyTarget,
): { tools: ProxiedTool[]; dropped: number } {
  const result =
    typeof reply === "object" && reply !== null
      ? (reply as Record<string, unknown>)["result"]
      : undefined;
  const listed =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)["tools"]
      : undefined;
  if (!Array.isArray(listed)) {
    return { tools: [], dropped: 0 };
  }
  const tools: ProxiedTool[] = [];
  let dropped = 0;
  for (const entry of listed) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const remoteName = record["name"];
    if (typeof remoteName !== "string" || remoteName.trim() === "") {
      dropped += 1;
      continue;
    }
    const name = proxyToolName(target.serverName, remoteName);
    if (name === undefined) {
      dropped += 1;
      continue;
    }
    if (tools.length >= MAX_TOOLS_PER_SERVER) {
      dropped += 1;
      continue;
    }
    const schema = record["inputSchema"];
    tools.push({
      name,
      remoteName,
      serverId: target.serverId,
      serverName: target.serverName,
      projectId: target.projectId,
      description:
        typeof record["description"] === "string"
          ? record["description"].slice(0, 4_000)
          : `A tool from the ${target.serverName} server.`,
      // Passed through as the far end wrote it, because it is the far end
      // that will validate against it. A schema this cannot read becomes the
      // permissive one rather than none: a tool with no schema at all is
      // uncallable by most clients.
      inputSchema:
        typeof schema === "object" && schema !== null && !Array.isArray(schema)
          ? (schema as Record<string, unknown>)
          : { type: "object", additionalProperties: true },
    });
  }
  return { tools, dropped };
}

interface CacheEntry {
  readonly revision: string;
  readonly expiresAt: number;
  readonly tools: readonly ProxiedTool[];
  /** Set when the dial failed; the tools are then empty and this says why. */
  readonly failure?: string;
}

/**
 * What each approved server offers, remembered between handshakes.
 *
 * Three behaviours matter and all three are about the same thing, which is
 * that `tools/list` is on the critical path of every editor session:
 *
 * - a hit costs nothing,
 * - concurrent misses for one server share a single dial rather than each
 *   opening their own, and
 * - a failure is remembered briefly, so a server that is down does not spend
 *   the handshake's patience on every attempt.
 */
export class McpManifestCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();

  public constructor(private readonly now: () => number = Date.now) {}

  /** This server's tools, from cache when it can be. */
  public async tools(
    target: ProxyTarget,
    dial: ProxyDial,
  ): Promise<{ tools: readonly ProxiedTool[]; failure?: string }> {
    const at = this.now();
    // Dropped on the way past rather than on a timer, which would be a handle
    // held open for the life of the process to tidy a map that only grows
    // while somebody is using it.
    //
    // This is also the whole of invalidation, and there is deliberately no
    // `forget` beside it. Every write to a server's row moves its
    // `updatedAt`, and an entry is keyed on that, so an edit or a withdrawn
    // approval invalidates itself on the next read. The only change that
    // leaves an entry nothing will ever ask about again is a deletion, and
    // that one expires here within the TTL like any other.
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.entries.delete(id);
      }
    }
    const cached = this.entries.get(target.serverId);
    if (
      cached !== undefined &&
      cached.revision === target.revision &&
      cached.expiresAt > at
    ) {
      return cached.failure === undefined
        ? { tools: cached.tools }
        : { tools: cached.tools, failure: cached.failure };
    }
    const existing = this.inFlight.get(target.serverId);
    if (existing !== undefined) {
      const shared = await existing;
      return shared.failure === undefined
        ? { tools: shared.tools }
        : { tools: shared.tools, failure: shared.failure };
    }
    const fetching = this.fetch(target, dial);
    this.inFlight.set(target.serverId, fetching);
    try {
      const entry = await fetching;
      this.entries.set(target.serverId, entry);
      return entry.failure === undefined
        ? { tools: entry.tools }
        : { tools: entry.tools, failure: entry.failure };
    } finally {
      if (this.inFlight.get(target.serverId) === fetching) {
        this.inFlight.delete(target.serverId);
      }
    }
  }

  private async fetch(
    target: ProxyTarget,
    dial: ProxyDial,
  ): Promise<CacheEntry> {
    try {
      const reply = await dial({
        url: target.url,
        headers: target.headers,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        timeoutMs: MANIFEST_TIMEOUT_MS,
      });
      const { tools } = toolsFromManifest(reply, target);
      return {
        revision: target.revision,
        expiresAt: this.now() + MANIFEST_TTL_MS,
        tools,
      };
    } catch (error) {
      return {
        revision: target.revision,
        expiresAt: this.now() + MANIFEST_FAILURE_TTL_MS,
        tools: [],
        failure:
          error instanceof McpDialError
            ? error.message
            : error instanceof Error
              ? error.message
              : "The server could not be reached.",
      };
    }
  }
}

/**
 * Every tool the caller's approved servers offer, namespaced and deduplicated.
 *
 * A name collision between two projects is resolved by keeping the first, in
 * a fixed order, rather than by renaming: a tool that changes its name when
 * somebody else's project adds a server would break a conversation already in
 * progress. Server names are unique within a project, so this only arises
 * across two, which is rare and visible on the settings screen.
 */
export async function proxiedTools(
  targets: readonly ProxyTarget[],
  dial: ProxyDial,
  cache: McpManifestCache,
): Promise<{ tools: ProxiedTool[]; failures: Array<{ server: string; reason: string }> }> {
  const ordered = [...targets].sort((left, right) =>
    left.projectId === right.projectId
      ? left.serverId.localeCompare(right.serverId)
      : left.projectId.localeCompare(right.projectId),
  );
  const answers = await Promise.all(
    // In parallel, because they are independent and a handshake waits for all
    // of them: serially, three slow servers would be three timeouts deep.
    ordered.map(async (target) => ({ target, ...(await cache.tools(target, dial)) })),
  );
  const tools: ProxiedTool[] = [];
  const failures: Array<{ server: string; reason: string }> = [];
  const claimed = new Set<string>();
  for (const answer of answers) {
    if (answer.failure !== undefined) {
      failures.push({ server: answer.target.serverName, reason: answer.failure });
      continue;
    }
    for (const tool of answer.tools) {
      if (claimed.has(tool.name)) {
        continue;
      }
      claimed.add(tool.name);
      tools.push(tool);
    }
  }
  return { tools, failures };
}

/**
 * Relays one tool call to the server that owns it.
 *
 * A failure comes back as a tool result rather than as a thrown error, for the
 * reason every refusal in this endpoint does: the person cannot go and look,
 * so the model has to be able to read what went wrong and say it out loud.
 */
export async function callProxiedTool(input: {
  tool: ProxiedTool;
  target: ProxyTarget;
  args: Record<string, unknown>;
  dial: ProxyDial;
}): Promise<McpToolResult> {
  let reply: unknown;
  try {
    reply = await input.dial({
      url: input.target.url,
      headers: input.target.headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: input.tool.remoteName, arguments: input.args },
      },
    });
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text:
            `${input.tool.serverName} could not be reached: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
  const envelope =
    typeof reply === "object" && reply !== null
      ? (reply as Record<string, unknown>)
      : {};
  const failed = envelope["error"];
  if (typeof failed === "object" && failed !== null) {
    const message = (failed as Record<string, unknown>)["message"];
    return {
      content: [
        {
          type: "text",
          text: `${input.tool.serverName} refused: ${
            typeof message === "string" ? message : "no reason given"
          }`,
        },
      ],
      isError: true,
    };
  }
  const result = envelope["result"];
  if (typeof result !== "object" || result === null) {
    return {
      content: [
        {
          type: "text",
          text: `${input.tool.serverName} answered in a shape Kumi could not read.`,
        },
      ],
      isError: true,
    };
  }
  const shaped = result as Record<string, unknown>;
  const content = shaped["content"];
  if (!Array.isArray(content)) {
    // A result with no content block is legal and means "it worked". Saying
    // so beats handing a model an empty answer it has to guess about.
    return mcpText(`${input.tool.serverName} ran ${input.tool.remoteName}.`);
  }
  // Relayed as the far end wrote it, including `isError`: this is the server's
  // answer to its own tool, and rewriting it here would be inventing one.
  return {
    content: content as McpToolResult["content"],
    ...(shaped["isError"] === true ? { isError: true as const } : {}),
  };
}
