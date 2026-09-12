/**
 * The MCP front door, and who the caller is.
 *
 * Kumi as an MCP server is one route carrying a whole protocol, so it sits
 * at the top of the authenticated chain rather than among the endpoints;
 * everything it can actually do is in `mcp-tools.ts`.
 *
 * The session plumbing the spec describes lives here rather than in `mcp.ts`:
 * `Mcp-Session-Id` is issued on a handshake that succeeded, read off later
 * requests, and ended by a `DELETE`, and none of that is possible in a module
 * with no store, no principal and no response to set a header on. What a
 * session *is*, and why it is a row rather than a map, is in `mcp-session.ts`.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  HttpError,
  hexColorField,
  objectBody,
} from "../field-validation.js";
import {
  publicUser,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  handleMcpMessage,
  MCP_PROTOCOL_VERSION,
} from "../mcp.js";
import {
  initializeParamsOf,
  initializedOk,
  parseSessionHeader,
  protocolVersionAcceptable,
  MCP_PROTOCOL_HEADER,
  MCP_SESSION_HEADER,
  MCP_SESSIONS_KEPT_PER_USER,
} from "../mcp-session.js";
import {
  BUILD_IDENTITY,
} from "../server.js";
import {
  SLASH_COMMANDS,
} from "../slash.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

/**
 * The one answer for a session id that is missing, ended, lapsed or somebody
 * else's.
 *
 * 404 rather than 403 in every case, including the wrong principal: 403 would
 * confirm to a stranger that the id exists, and 404 is the status the spec
 * says makes a client re-`initialize` — which is what it should do in all four
 * cases anyway. The JSON-RPC error code is not load-bearing (the HTTP status
 * is); -32001 is what common implementations use for this.
 */
function unknownSession(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32001,
      message: "Unknown or ended session; initialize again without Mcp-Session-Id",
    },
  };
}

export async function routeSession(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  // Kumi as an MCP server: one route, JSON-RPC 2.0 over a single POST.
  //
  // Placed first because it is the whole of a protocol rather than one more
  // endpoint, and because everything it can do is in `mcp-tools.ts` where it
  // can be read in one sitting. See `mcp.ts` for why this is hand-rolled and
  // why it answers in JSON rather than opening a stream.
  if (path === `${API_PREFIX}/mcp`) {
    const sessionId = parseSessionHeader(request.headers[MCP_SESSION_HEADER]);
    if (method === "DELETE") {
      // The spec's way for a client to say it is finished. Kept separate from
      // revoking the token: ending a session ends this connection's continuity
      // and nothing else, and the row stays as the history the next handshake
      // is seeded from.
      if (sessionId === undefined) {
        gw.sendJson(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "DELETE needs an Mcp-Session-Id header",
          },
        });
        return true;
      }
      if (!(await gw.endMcpSession(principal, sessionId))) {
        gw.sendJson(response, 404, unknownSession());
        return true;
      }
      response.writeHead(200, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (method !== "POST") {
      // Clients probe for an SSE stream on GET. Answering in the JSON-RPC
      // shape rather than the gateway's own error envelope is what makes a
      // client say "this server does not stream" instead of "transport
      // failed".
      gw.sendJson(response, 405, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "This endpoint accepts POST only; it does not stream",
        },
      });
      return true;
    }
    // The same rule `initialize` applies when it echoes a version back: a
    // revision this server has never heard of is refused rather than served
    // something the client will misread. Absent is fine — the spec says to
    // assume the revision before this header existed.
    const askedProtocol = request.headers[MCP_PROTOCOL_HEADER];
    if (
      typeof askedProtocol === "string" &&
      !protocolVersionAcceptable(askedProtocol)
    ) {
      gw.sendJson(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message:
            `This server speaks MCP ${MCP_PROTOCOL_VERSION}; ` +
            `it cannot answer for "${askedProtocol}"`,
        },
      });
      return true;
    }
    let payload: unknown;
    try {
      payload = await gw.readJson(request);
    } catch {
      gw.sendJson(response, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Body was not valid JSON" },
      });
      return true;
    }
    // Resolved only for the two methods that read a tool list. `initialize`
    // and `notifications/initialized` arrive first and would otherwise pay
    // for a manifest fetch before the session has asked for anything.
    //
    // `initialize` does now read the store, for the brief below, and it is the
    // only method here that does. That is affordable and bounded on purpose:
    // three session rows, at most five task lookups with one narrow audit read
    // each, and one handoff-and-standing-context seed for a single repository
    // which is cached per person and repository for a minute. The proxy
    // manifest fetch — a round trip to somebody else's infrastructure — stays
    // gated exactly as it was.
    const asked =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["method"]
        : undefined;
    const needsTools = asked === "tools/list" || asked === "tools/call";
    // A handshake starts a session rather than continuing one, even when a
    // header came with it: Claude Code opens a session per task, and reusing
    // the old row would blur two runs' histories into one.
    const session =
      asked === "initialize" || sessionId === undefined
        ? undefined
        : await gw.resolveMcpSession(principal, sessionId);
    if (asked !== "initialize" && sessionId !== undefined && session === undefined) {
      gw.sendJson(response, 404, unknownSession());
      return true;
    }
    const opened =
      asked === "initialize"
        ? gw.openMcpSession(principal, initializeParamsOf(payload))
        : undefined;
    const reply = await handleMcpMessage({
      payload,
      tools: [
        ...gw.mcpTools(principal, session),
        ...(needsTools ? await gw.proxyTools(principal) : []),
      ],
      serverName: "kumi",
      serverVersion: BUILD_IDENTITY,
      ...(opened === undefined
        ? {}
        : {
            // Swallowed rather than raised: the brief is a convenience read
            // across several tables, and a handshake that failed because one
            // of them was unhappy would take the whole connection with it.
            instructions: await gw
              .mcpSessionBrief(principal, opened)
              .catch(() => ""),
          }),
    });
    // Minted on the answer, not on the question. `handleMcpMessage` refuses a
    // message that is not JSON-RPC 2.0, and answers one with no id as a
    // notification, both before the `initialize` branch — so keying on the
    // parsed method would hand out a session id on an error reply for a
    // session this server never recorded.
    if (opened !== undefined && initializedOk(reply)) {
      // The header goes out only if the row went in. Handing out an id this
      // server could not record would have the client present it on every
      // later call and be answered 404 by each of them; without the header it
      // simply carries on statelessly, which still works.
      //
      // `opened.row`, not the literal the handshake started from: the brief
      // ran in between, and a focus it inherited from the last session has to
      // be in the row or the tools it just promised would default to nothing.
      const recorded = await gw.options.store
        .createMcpSession(opened.row, {
          keepPerUser: MCP_SESSIONS_KEPT_PER_USER,
        })
        .then(
          () => true,
          () => false,
        );
      if (recorded) {
        response.setHeader("Mcp-Session-Id", opened.id);
      }
    }
    if (reply.body === undefined) {
      // A notification. No body at all — see `mcp.ts`.
      response.writeHead(reply.status, { "Cache-Control": "no-store" });
      response.end();
    } else {
      gw.sendJson(response, reply.status, reply.body);
    }
    // After the answer, and swallowed if it fails. This write is bookkeeping —
    // last seen, the sliding expiry, a moved focus, the notes this request
    // added — and a tool that ran and reported its result must not be turned
    // into a transport error by a failed record of the fact.
    if (session !== undefined) {
      await gw.touchMcpSession(session).catch(() => undefined);
    }
    return true;
  }

  if (method === "POST" && path === `${API_PREFIX}/auth/logout`) {
    // A bearer token has no session to end; revoking it is a separate,
    // explicit action so a stray logout cannot disable a running worker.
    if (principal.sessionId === undefined) {
      throw new HttpError(
        400,
        "not_a_session",
        "Bearer tokens are revoked through /auth/tokens, not sign-out",
      );
    }
    response.setHeader(
      "Set-Cookie",
      await gw.auth.logout(principal.sessionId, context.secure),
    );
    await gw.options.store.appendAudit(undefined, {
      type: "user_signed_out",
      data: { userId: principal.user.id },
    });
    gw.sendJson(response, 200, { signedOut: true });
    return true;
  }
  if (method === "GET" && path === `${API_PREFIX}/auth/me`) {
    // Commands belong to every authenticated conversation surface, not only
    // to a channel that happened to have loaded its first page of messages.
    // Sending the catalogue with the session makes it available to a private
    // agent chat opened directly from a channel, while the channel response
    // continues to carry it for older clients.
    gw.sendJson(response, 200, {
      ...principal,
      slashCommands: SLASH_COMMANDS,
    });
    return true;
  }

  // A person's own interface colours. Scoped to the authenticated principal
  // with no user id in the path, so there is no request shape that edits
  // somebody else's appearance.
  if (method === "PATCH" && path === `${API_PREFIX}/auth/me/appearance`) {
    const body = objectBody(await gw.readJson(request));
    // A PATCH names only what it changes. The stored value is one object, so
    // an unnamed field has to be carried over: sending just `agentColor`
    // must not silently clear the accent the user picked a moment earlier.
    const current = await gw.options.store.getUser(principal.user.id);
    const appearance = {
      ...current?.appearance,
      ...(body["accent"] === undefined
        ? {}
        : { accent: hexColorField(body["accent"], "accent") }),
      ...(body["accentSecondary"] === undefined
        ? {}
        : {
            accentSecondary: hexColorField(
              body["accentSecondary"],
              "accentSecondary",
            ),
          }),
      ...(body["agentColor"] === undefined
        ? {}
        : { agentColor: hexColorField(body["agentColor"], "agentColor") }),
    };
    const updated = await gw.options.store.updateUser(principal.user.id, {
      appearance,
    });
    gw.sendJson(response, 200, { user: publicUser(updated) });
    return true;
  }

  return false;
}
