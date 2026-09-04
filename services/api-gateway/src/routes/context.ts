/**
 * What a route group is handed, and the two shapes it comes in.
 *
 * The distinction between them is the whole reason `route()` runs two chains
 * instead of one. `requirePrincipal` throws, so everything reachable without
 * a caller has to be answered before it is called - and that used to be a
 * single line sitting three thousand lines into an eight-thousand-line
 * method, with nothing but position to say which side of it a route was on.
 *
 * Here it is a type. A public route has no `principal` field to reach for,
 * and an authenticated one cannot be reached without it having been
 * resolved, so filing a route in the wrong group is a compile error rather
 * than a 500 for whoever needed it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthenticatedPrincipal } from "../auth.js";
import type { RequestContext } from "../gateway-types.js";

/** A request that has been parsed, and nothing more. */
export interface RouteRequest {
  readonly context: RequestContext;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  /** `GET` when the client sent no method, matching Node's own default. */
  readonly method: string;
  /** `url.pathname`, lifted out because every branch matches against it. */
  readonly path: string;
}

/** The same, once the caller has been identified. */
export interface AuthenticatedRouteRequest extends RouteRequest {
  readonly principal: AuthenticatedPrincipal;
}
