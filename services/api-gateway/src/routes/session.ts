/**
 * The MCP front door, and who the caller is.
 *
 * Kumi as an MCP server is one route carrying a whole protocol, so it sits
 * at the top of the authenticated chain rather than among the endpoints;
 * everything it can actually do is in `mcp-tools.ts`.
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
} from "../mcp.js";
import {
  BUILD_IDENTITY,
} from "../server.js";
import {
  SLASH_COMMANDS,
} from "../slash.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

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
    const asked =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["method"]
        : undefined;
    const needsTools = asked === "tools/list" || asked === "tools/call";
    const reply = await handleMcpMessage({
      payload,
      tools: [
        ...gw.mcpTools(principal),
        ...(needsTools ? await gw.proxyTools(principal) : []),
      ],
      serverName: "kumi",
      serverVersion: BUILD_IDENTITY,
    });
    if (reply.body === undefined) {
      // A notification. No body at all — see `mcp.ts`.
      response.writeHead(reply.status, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    gw.sendJson(response, reply.status, reply.body);
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
