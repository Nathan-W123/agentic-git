/**
 * The two questions a container platform asks, which are not the same
 * question and must never be answered by the same check.
 *
 * **Liveness** — "is this process worth keeping?" A failed answer gets the
 * container killed and replaced, so it must depend on nothing that can be
 * slow, briefly absent, or somebody else's. A liveness probe that touched
 * the database would turn every database blip into a rolling restart of a
 * control plane that was working perfectly: the deployment goes from
 * degraded to down, and the probe is the reason.
 *
 * **Readiness** — "should traffic go here yet?" A failed answer only takes
 * this instance out of rotation, so it is allowed to ask real questions —
 * and has to. An instance whose store is unreachable answers 500 to
 * everything it is sent, and calling itself ready is how those 500s reach
 * people.
 *
 * **Answered before anything else.** These are checked at the top of the
 * request, ahead of the rate limiter and ahead of the static-asset
 * fallback, and both of those placements are deliberate:
 *
 *   - A probe arrives from one address every few seconds forever, which is
 *     exactly the shape a per-IP limiter exists to refuse. A 429 to a
 *     liveness probe is a killed container, so the probe would eventually
 *     restart a healthy deployment on a timer.
 *   - Every path that does not start with the API prefix is served from the
 *     static asset table, so before this existed `GET /healthz` returned the
 *     dashboard's HTML with a 200. Anything checking it would have been
 *     satisfied by a control plane that could not reach its database at all.
 *
 * **Unauthenticated, because a probe has no credential to offer.** That is
 * why neither carries a detail. `/healthz` says only that it is alive.
 * `/readyz` names *which* check failed and never why: a database driver's
 * own message can carry a host, a port, a user, sometimes a fragment of a
 * connection URL with a password in it, and this is a route that absolutely
 * anybody can read.
 *
 * **Not a narrowing of `/api/v1/health`,** which stays exactly as it is. The
 * desktop app probes it to tell a typo from a deployment before anybody is
 * signed in, the first-run form reads it to know whether to ask for a
 * bootstrap token, and it is how a deploy is confirmed from outside. It
 * answers a different question than either of these, for a different reader.
 */

import type { CoordinationStore } from "@coord/persistence";
import type { StaticAsset } from "./gateway-types.js";

/** What a probe needs to know, which is deliberately almost nothing. */
export interface ProbeSubject {
  store: Pick<CoordinationStore, "ping" | "lastConnectionLoss">;
  /** The dashboard, read into memory at boot. */
  staticAssets?: ReadonlyMap<string, StaticAsset> | undefined;
}

export interface ProbeAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** Alive. Nothing is awaited and nothing is read; answering is the signal. */
export function liveness(): ProbeAnswer {
  return { status: 200, body: { status: "ok" } };
}

/**
 * Ready, or the name of the first thing that is not.
 *
 * Both checks are run even when the first fails, because "the store is gone
 * *and* the dashboard never loaded" and "only the store is gone" are
 * different mornings for whoever is reading this, and short-circuiting would
 * hide the second one until the first was fixed.
 */
export async function readiness(subject: ProbeSubject): Promise<ProbeAnswer> {
  const checks: Record<string, "ok" | "failed"> = {};

  try {
    // Any lazy migration is awaited inside this, so a deployment still
    // building its schema reports unready rather than reporting a connection
    // failure it does not have.
    await subject.store.ping();
    checks["store"] = "ok";
  } catch {
    checks["store"] = "failed";
  }

  // The dashboard is read into memory at boot and served from there. A
  // process holding none of it answers the API perfectly and serves a blank
  // page to every browser — precisely a "do not send traffic here"
  // condition, and precisely what nothing was checking.
  checks["assets"] = (subject.staticAssets?.size ?? 0) > 0 ? "ok" : "failed";

  const ready = Object.values(checks).every((state) => state === "ok");
  // Advisory, and deliberately not a reason to be unready: it says the
  // database went away at some point, not that it is away now — the probe
  // above is what answers that. It is here because a control plane that is
  // answering fine and lost its connection an hour ago is the case where
  // nobody has any other way to find out.
  const lost = subject.store.lastConnectionLoss?.();

  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? "ready" : "unready",
      checks,
      ...(lost === undefined ? {} : { lastConnectionLoss: lost.at }),
    },
  };
}

/** Whether a path is one of these, so the caller can answer it early. */
export function isProbePath(path: string): boolean {
  return path === "/healthz" || path === "/readyz";
}
