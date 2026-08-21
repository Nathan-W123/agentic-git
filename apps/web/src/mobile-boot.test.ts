import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface ProjectLoad {
  key: string;
  path: (project: string, organization: string) => string;
  field: string;
  optional: boolean;
}

interface BootPlan {
  FIRST_PAINT_PROJECT_LOADS: readonly ProjectLoad[];
  DEFERRED_PROJECT_LOADS: readonly ProjectLoad[];
  FIRST_PAINT_ROUND_TRIPS: number;
}

interface DataModule {
  loadContext: (options?: { defer?: boolean }) => Promise<void>;
  loadDeferredContext: () => Promise<void>;
  state: Record<string, unknown>;
}

async function bootPlan(): Promise<BootPlan> {
  return (await import(
    pathToFileURL(path.join(packageRoot, "public", "boot-plan.js")).href
  )) as unknown as BootPlan;
}

test("the loading shell is painted before boot waits and leaves on every outcome", async () => {
  const publicRoot = path.join(packageRoot, "public");
  const [html, app] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
  ]);

  const shell = html.indexOf('class="boot-shell" role="status"');
  const module = html.indexOf('<script type="module" src="/app.js">');
  assert.notEqual(shell, -1);
  assert.equal(shell < module, true, "the shell exists before app.js can request context");
  assert.match(html, /id="app-root" aria-busy="true"/u);

  const boot = app.slice(
    app.indexOf("async function boot() {"),
    app.indexOf("\nvoid boot();"),
  );
  assert.equal(
    boot.indexOf("renderLoadingShell();") < boot.indexOf("loadContext({ defer: true })"),
    true,
    "the script reinforces the shell before starting boot requests",
  );
  assert.match(boot, /const contextFailure = loadContext\(\{ defer: true \}\)/u);
  assert.match(boot, /const healthFailure = loadHealth\(\)\.then/u);
  assert.match(boot, /const failure = \(await contextFailure\) \?\? healthError;/u);
  assert.match(boot, /if \(failure\.status === 401\) \{[\s\S]{0,120}showAuth\(\);/u);
  assert.match(boot, /state\.loadError = failure\.message;/u);
  assert.match(boot, /showApp\(\);\s*applyHash\(\);\s*render\(\);/u);
  assert.match(app, /"Lattice could not load",\s*state\.loadError/u);

  // Both destinations replace the status surface rather than leaving a busy
  // region hidden beside the authenticated or signed-out UI. This is DOM-only
  // work and therefore adds no request to the cold-start count below.
  const showAuth = app.slice(
    app.indexOf("function showAuth() {"),
    app.indexOf("\n/**\n * Ends the session", app.indexOf("function showAuth() {")),
  );
  assert.match(showAuth, /appRoot\.removeAttribute\("aria-busy"\);/u);
  assert.match(showAuth, /appRoot\.innerHTML = "";/u);
  const showApp = app.slice(
    app.indexOf("function showApp() {"),
    app.indexOf("\n/** Refreshes context", app.indexOf("function showApp() {")),
  );
  assert.match(showApp, /appRoot\.removeAttribute\("aria-busy"\);/u);
  assert.match(app, /root\.removeAttribute\("aria-busy"\);/u);
});

/**
 * The answers a control plane with one organization and one project gives.
 * Anything not named here answers `{}`, which every load reads as empty.
 */
const RESPONSES: Readonly<Record<string, unknown>> = {
  "/auth/me": { id: "u1", displayName: "Owner" },
  "/organizations": { organizations: [{ id: "org1" }] },
  "/organizations/org1/projects": { projects: [{ id: "p1" }] },
  "/projects/p1": { project: { id: "p1" } },
};

/**
 * Loads the dashboard's data module against a counting `fetch`.
 *
 * The interesting number is not how many requests a cold start makes but how
 * many of them are stacked behind each other, so the stub groups requests into
 * waves: a new wave begins whenever nothing is in flight. Requests issued
 * together land in one wave, and a wave is one round trip of the phone's
 * latency — the thing a person actually waits through.
 */
async function bootHarness(): Promise<{
  data: DataModule;
  waves: string[][];
  requests: () => string[];
}> {
  const scope = globalThis as unknown as {
    window?: unknown;
    fetch: typeof fetch;
  };
  scope.window ??= {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  const waves: string[][] = [];
  let inFlight = 0;
  scope.fetch = (async (input: string) => {
    const requested = String(input).replace(/^\/api\/v1/u, "");
    if (inFlight === 0) {
      waves.push([]);
    }
    inFlight += 1;
    waves[waves.length - 1]?.push(requested);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return new Response(JSON.stringify(RESPONSES[requested] ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const data = (await import(
    pathToFileURL(path.join(packageRoot, "public", "data.js")).href
  )) as unknown as DataModule;
  return {
    data,
    waves,
    requests: () => waves.flat(),
  };
}

test("a cold start costs three round trips and ten requests", async () => {
  const plan = await bootPlan();
  const { data, waves, requests } = await bootHarness();

  await data.loadContext({ defer: true });

  // Health, the session and the organization list depend on nothing but the
  // cookie; the projects depend on the organization; the project's own loads
  // depend on the project. Three waits, and that is the floor without an API
  // change. The health call is not counted here because `boot` starts it
  // alongside the session rather than before it: it rides in the first wave
  // and adds no wait of its own.
  assert.equal(waves.length, plan.FIRST_PAINT_ROUND_TRIPS);
  assert.deepEqual(waves[0]?.sort(), ["/auth/me", "/organizations"]);
  assert.deepEqual(waves[1]?.sort(), [
    "/organizations/org1/members",
    "/organizations/org1/projects",
  ]);
  // Nine of these used to be one wave with the four deferred loads in it.
  assert.equal(waves[2]?.length, plan.FIRST_PAINT_PROJECT_LOADS.length);
  assert.equal(requests().length, 9);

  // The four that no longer stand between tapping the icon and seeing a
  // screen. Each was a request and a payload the first paint waited for.
  for (const load of plan.DEFERRED_PROJECT_LOADS) {
    const deferred = load.path("p1", "org1");
    assert.equal(
      requests().includes(deferred),
      false,
      `${deferred} should not be fetched before the first paint`,
    );
  }
  assert.equal(data.state["loaded"], true);
});

test("the deferred loads arrive in one round trip after the screen does", async () => {
  const plan = await bootPlan();
  const { data, waves, requests } = await bootHarness();

  await data.loadContext({ defer: true });
  const beforeFirstPaint = requests().length;
  const wavesBefore = waves.length;

  await data.loadDeferredContext();

  assert.equal(waves.length, wavesBefore + 1);
  assert.equal(
    requests().length - beforeFirstPaint,
    plan.DEFERRED_PROJECT_LOADS.length,
  );
  for (const load of plan.DEFERRED_PROJECT_LOADS) {
    assert.equal(requests().includes(load.path("p1", "org1")), true);
  }
});

test("a refresh of a screen somebody is looking at still loads everything", async () => {
  const plan = await bootPlan();
  const { data, waves, requests } = await bootHarness();

  // No `defer`: every other caller is refreshing an app that is already up,
  // where splitting the fan-out would buy nothing and cost a round trip.
  await data.loadContext();

  assert.equal(waves.length, plan.FIRST_PAINT_ROUND_TRIPS);
  assert.equal(
    requests().length,
    4 +
      plan.FIRST_PAINT_PROJECT_LOADS.length +
      plan.DEFERRED_PROJECT_LOADS.length,
  );
  for (const load of plan.DEFERRED_PROJECT_LOADS) {
    assert.equal(requests().includes(load.path("p1", "org1")), true);
  }
});

test("nothing a first paint needs was quietly moved into the deferred table", async () => {
  const plan = await bootPlan();
  const keys = plan.FIRST_PAINT_PROJECT_LOADS.map((load) => load.key);
  // The chat screen — what the app opens on — is drawn from these four, and
  // the repository list is what the header names. Moving any of them after
  // the paint would trade a round trip for an empty screen.
  for (const key of ["repositories", "tasks", "approvals", "project"]) {
    assert.equal(keys.includes(key), true, `${key} is needed to draw`);
  }
  const deferredKeys = plan.DEFERRED_PROJECT_LOADS.map((load) => load.key);
  assert.deepEqual(deferredKeys.sort(), [
    "audit",
    "metrics",
    "runs",
    "workers",
  ]);
  // Two tables, no overlap: a key in both would be fetched twice per refresh.
  for (const key of deferredKeys) {
    assert.equal(keys.includes(key), false, `${key} is in both tables`);
  }
});
