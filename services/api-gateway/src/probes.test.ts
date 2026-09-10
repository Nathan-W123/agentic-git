/**
 * The probes, and the three ways a probe is worse than nothing.
 *
 * A liveness check that consults a dependency turns a database blip into a
 * killed container. A readiness check that cannot fail reports ready
 * straight through an outage — which is the one moment anybody reads it. And
 * a probe that answers 200 because *something else* answered 200 satisfies
 * every alert while telling you nothing at all, which is what `/healthz`
 * did here before these existed: it fell through to the static asset table
 * and returned the dashboard's HTML.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { StaticAsset } from "./gateway-types.js";
import { isProbePath, liveness, readiness } from "./probes.js";
import { startRuntime, startBareGateway, TestClient } from "./test-harness.js";

const html: StaticAsset = { body: "<!doctype html>", contentType: "text/html" };
const loaded = new Map<string, StaticAsset>([["/index.html", html]]);

function store(over: {
  ping?: () => Promise<void>;
  lost?: { at: string; message: string };
}) {
  return {
    ping: over.ping ?? (async () => undefined),
    lastConnectionLoss: () => over.lost,
  };
}

/* --------------------------------------------------------------- shapes -- */

test("liveness consults nothing", () => {
  // Not a style preference. Anything this awaited would be a dependency
  // whose bad minute becomes a container restart of a process that was
  // working — the deployment goes from degraded to down and the probe is
  // the reason. So the test is that it is synchronous and takes no subject.
  const answer = liveness();
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { status: "ok" });
});

test("readiness fails when the store cannot answer", async () => {
  const answer = await readiness({
    store: store({
      ping: async () => {
        throw new Error(
          "connect ECONNREFUSED 10.0.0.5:5432 user=coordinator password=hunter2",
        );
      },
    }),
    staticAssets: loaded,
  });
  assert.equal(answer.status, 503);
  assert.equal(answer.body["status"], "unready");
  assert.deepEqual(answer.body["checks"], { store: "failed", assets: "ok" });
  // And says which, never why. This route needs no credential to read, and a
  // driver's own message carries hosts, ports, users and sometimes a
  // password out of a connection URL.
  const serialised = JSON.stringify(answer.body);
  assert.doesNotMatch(serialised, /ECONNREFUSED|10\.0\.0\.5|hunter2/u);
});

test("readiness fails when the dashboard never loaded", async () => {
  // The failure with no other symptom. Assets are read into memory at boot,
  // so a process holding none of them answers every API call perfectly and
  // serves a blank page to every browser.
  const answer = await readiness({ store: store({}), staticAssets: new Map() });
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.body["checks"], { store: "ok", assets: "failed" });
  assert.equal(
    (await readiness({ store: store({}) })).status,
    503,
    "no asset map at all is the same condition as an empty one",
  );
});

test("both failures are reported, not just the first", async () => {
  // Short-circuiting would hide the second until the first was fixed, which
  // costs whoever is reading this an extra round trip through a deploy.
  const answer = await readiness({
    store: store({
      ping: async () => {
        throw new Error("gone");
      },
    }),
    staticAssets: new Map(),
  });
  assert.deepEqual(answer.body["checks"], { store: "failed", assets: "failed" });
});

test("a connection lost in the past is reported and is not a failure", async () => {
  const answer = await readiness({
    store: store({ lost: { at: "2026-09-10T04:00:00.000Z", message: "reset" } }),
    staticAssets: loaded,
  });
  // Ready. It says the database went away at some point, not that it is away
  // now — `ping` is what answers that, and it just did.
  assert.equal(answer.status, 200);
  assert.equal(answer.body["lastConnectionLoss"], "2026-09-10T04:00:00.000Z");
  // The timestamp, never the driver's sentence.
  assert.doesNotMatch(JSON.stringify(answer.body), /reset/u);
});

test("only these two paths are probes", () => {
  assert.equal(isProbePath("/healthz"), true);
  assert.equal(isProbePath("/readyz"), true);
  assert.equal(isProbePath("/health"), false);
  assert.equal(isProbePath("/healthz/"), false);
  assert.equal(isProbePath("/readyz?verbose=1"), false);
});

/* ----------------------------------------------------------- over HTTP -- */

test("the probes answer before the static assets do", async (t) => {
  const runtime = await startRuntime(t, {});
  const client = new TestClient(runtime.origin);

  const alive = await client.request("/healthz");
  assert.equal(alive.status, 200);
  // The whole point of the route existing. Before it, this path did not
  // start with the API prefix, so it fell through to the asset table and
  // came back as the dashboard with a 200 — an answer that would satisfy
  // any check made of it by a control plane that could not reach its
  // database at all.
  assert.equal(alive.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(alive.data, { status: "ok" });

  const ready = await client.request("/readyz");
  assert.equal(ready.status, 200);
  assert.equal(ready.data.status, "ready");
  assert.deepEqual(ready.data.checks, { store: "ok", assets: "ok" });
});

test("a probe is never rate limited", async (t) => {
  // A probe arrives from one address every few seconds forever, which is
  // exactly the shape a per-IP limiter exists to refuse — and a 429 to a
  // liveness probe is a killed container, so the limiter would restart a
  // healthy deployment on a timer. The limit is set to two here so the test
  // is about the rule rather than about patience.
  const runtime = await startRuntime(t, { rateLimitPerMinute: 2 });
  const client = new TestClient(runtime.origin);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const answer = await client.request("/healthz");
    assert.equal(answer.status, 200, `probe ${String(attempt)} was refused`);
  }
  // And the limiter is still doing its job for everything else, so this has
  // not been bought by turning it off. Asked until it refuses rather than at
  // a counted position, because how much of the budget the harness itself
  // spent standing the gateway up is not this test's business and pinning it
  // would make this fail the next time that changes.
  let refused = false;
  for (let attempt = 0; attempt < 10 && !refused; attempt += 1) {
    refused = (await client.request("/api/v1/health")).status === 429;
  }
  assert.ok(refused, "the limiter should still refuse an ordinary request");
});

test("an unready deployment says so over HTTP", async (t) => {
  // A gateway with no assets at all, which is a real boot: the process comes
  // up, binds, answers the API, and serves nothing to a browser.
  const { client, store: opened } = await startBareGateway(t, {});
  const unready = await client.request("/readyz");
  assert.equal(unready.status, 503);
  assert.equal(unready.data.status, "unready");
  assert.equal(unready.data.checks.assets, "failed");
  assert.equal(unready.data.checks.store, "ok");

  // Liveness is untouched by any of that, which is the distinction the two
  // routes exist to draw: this process is worth keeping, it should just not
  // be sent traffic yet.
  assert.equal((await client.request("/healthz")).status, 200);

  // And when the store goes too, readiness notices rather than reporting the
  // last answer it happened to have.
  await opened.close();
  const gone = await client.request("/readyz");
  assert.equal(gone.status, 503);
  assert.equal(gone.data.checks.store, "failed");
});

test("the health route survives its store going away", async (t) => {
  // The failure this was: `setupRequired` is a real `countUsers()` against
  // the store, it had no guard, and `database` beside it was the literal
  // string "ready" — written down rather than found out, and therefore
  // saying "ready" on every deployment in every state.
  //
  // So a control plane whose database was briefly away answered 500 here,
  // and the desktop app — whose whole contract with this route is 200 plus
  // `status: "ok"` — told the person at the keyboard "That does not look
  // like a Kumi deployment". A database restart was reported to the user as
  // having typed their own server address wrong.
  const { client, store: opened } = await startBareGateway(t, {});
  const before = await client.request("/api/v1/health");
  assert.equal(before.status, 200);
  assert.equal(before.data.database, "ready");
  assert.equal(before.data.setupRequired, true);

  await opened.close();
  const during = await client.request("/api/v1/health");
  // Still 200, still a Kumi. That is the question this route is asked.
  assert.equal(during.status, 200);
  assert.equal(during.data.status, "ok");
  // And now it says so, which is the whole of what "ready" never did.
  assert.equal(during.data.database, "unavailable");
  // Omitted rather than guessed. Every reader tests it with `=== true`, so
  // absent behaves exactly as the old hardcoded `false` did without
  // asserting something nobody was in a position to check.
  assert.equal(during.data.setupRequired, undefined);
});

test("the health route the desktop app probes is unchanged", async (t) => {
  // These are new routes rather than a narrowing of that one. The desktop
  // app requires 200 and `status: "ok"` from it to tell a typo from a
  // deployment before anybody is signed in, and the first-run form reads it
  // to know whether to ask for a bootstrap token.
  const runtime = await startRuntime(t, {});
  const client = new TestClient(runtime.origin);
  const health = await client.request("/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");
  assert.equal(typeof health.data.setupRequired, "boolean");
});

test("a probe path is not a way past authentication", async (t) => {
  // The routes are answered ahead of everything, so the thing to pin is that
  // "ahead of everything" is exactly two exact paths and two methods, and
  // that nothing near them slipped through with it.
  const runtime = await startRuntime(t, {});
  const anonymous = new TestClient(runtime.origin);
  for (const [path, expected] of [
    ["/healthz", 200],
    ["/readyz", 200],
  ] as const) {
    assert.equal((await anonymous.request(path)).status, expected);
    // A write to a probe path is not a probe. It falls through to whatever
    // the path would otherwise have been, and must never be answered 200 by
    // this.
    const written = await anonymous.request(path, { method: "POST" });
    assert.notEqual(written.status, 200);
  }
  // A signed-out request for something real is still refused.
  const refused = await anonymous.request("/api/v1/session");
  assert.equal(refused.status, 401);
});
