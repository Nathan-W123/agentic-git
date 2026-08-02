import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadStaticAssets } from "./assets.js";

test("loads every control-room asset with an explicit content type", async () => {
  const assets = await loadStaticAssets();
  assert.equal(assets.get("/index.html")?.contentType, "text/html; charset=utf-8");
  assert.equal(
    assets.get("/app.js")?.contentType,
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    assets.get("/jarvis.css")?.contentType,
    "text/css; charset=utf-8",
  );
  assert.equal(
    assets.get("/hud-interface-bg.png")?.contentType,
    "image/png",
  );
  assert.equal(
    assets.get("/hud-reactor-rotor.png")?.contentType,
    "image/png",
  );
  assert.equal(
    assets.get("/editor.js")?.contentType,
    "text/javascript; charset=utf-8",
  );
});

test("serves the vendored Monaco build same-origin under /vendor", async () => {
  const assets = await loadStaticAssets();
  // The AMD loader and main bundle are what /editor.js requests at runtime;
  // the worker is what Monaco spawns for language services. CSP allows no
  // CDN, so these must exist locally or the editor cannot function.
  for (const asset of [
    "/vendor/monaco/vs/loader.js",
    "/vendor/monaco/vs/editor/editor.main.js",
    "/vendor/monaco/vs/editor/editor.main.css",
    "/vendor/monaco/vs/base/worker/workerMain.js",
  ]) {
    assert.equal(
      assets.get(asset)?.contentType?.startsWith("text/"),
      true,
      `${asset} should be served`,
    );
  }
});

test("a missing vendor directory degrades to dashboard-only assets", async () => {
  const assets = await loadStaticAssets(undefined, false, false);
  assert.equal(assets.get("/app.js") !== undefined, true);
  assert.equal(assets.get("/vendor/monaco/vs/loader.js"), undefined);
  assert.equal(assets.get("/vendor/collab/index.js"), undefined);
});

test("serves the collaboration engine the gateway itself runs", async () => {
  const assets = await loadStaticAssets();
  // Operational transformation only converges if both ends transform
  // identically, so the browser loads the very same compiled module the
  // gateway imports rather than a second implementation of it.
  for (const asset of [
    "/vendor/collab/index.js",
    "/vendor/collab/client.js",
    "/vendor/collab/text-operation.js",
  ]) {
    assert.equal(
      assets.get(asset)?.contentType,
      "text/javascript; charset=utf-8",
      `${asset} should be served`,
    );
  }
});

test("does not serve the collaboration package's test scaffolding", async () => {
  const assets = await loadStaticAssets();
  // Those modules import node builtins and would fail to load in a browser;
  // more to the point, nothing should ship to clients that is not needed.
  for (const asset of [
    "/vendor/collab/random.js",
    "/vendor/collab/client.test.js",
    "/vendor/collab/text-operation.test.js",
    "/vendor/collab/convergence.test.js",
  ]) {
    assert.equal(assets.get(asset), undefined, `${asset} should not be served`);
  }
});

test("the collaboration engine is browser-safe", async () => {
  const assets = await loadStaticAssets();
  // A single `node:` import anywhere in the served graph breaks the editor at
  // load time, and only in a browser — no test that runs under node would
  // catch it.
  for (const [url, asset] of assets) {
    if (!url.startsWith("/vendor/collab/")) {
      continue;
    }
    const source = asset.body.toString("utf8");
    assert.equal(
      /from\s+"node:/u.test(source),
      false,
      `${url} imports a node builtin`,
    );
    assert.equal(
      /\brequire\(/u.test(source),
      false,
      `${url} is not an ES module`,
    );
  }
});

async function browserSource(): Promise<string> {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  return await readFile(path.join(packageRoot, "public", "app.js"), "utf8");
}

async function hudStyleSource(): Promise<string> {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  return await readFile(
    path.join(packageRoot, "public", "jarvis.css"),
    "utf8",
  );
}

/** Lifts one self-contained top-level function out of the browser bundle. */
function extract<T>(source: string, name: string, nextName: string): T {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  assert.notEqual(start, -1, `${name} was not found in app.js`);
  assert.notEqual(end, -1, `${nextName} was not found after ${name}`);
  return new Function(
    `${source.slice(start, end)}\nreturn ${name};`,
  )() as T;
}

type PolicyInput = {
  approvalsEnabled?: boolean;
  requireSchemaReview?: boolean;
  requireChangesetReview?: boolean;
  riskLevels?: string[];
  protectedPaths?: string;
  approvalTimeoutMinutes?: string;
  maxTaskRuntimeMinutes?: string;
  maxProjectRuntimeMinutesPerDay?: string;
};
type PolicyBody = { policy: Record<string, unknown> | null };

test("an untouched policy form clears the policy rather than storing an empty one", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  // Storing `{version: 1}` would look identical in the UI but would pin the
  // project against future changes to the built-in defaults.
  assert.deepEqual(policyPayload({}), { policy: null });
  assert.deepEqual(
    policyPayload({ riskLevels: [], protectedPaths: "\n  \n" }),
    { policy: null },
  );
});

test("the policy form distinguishes an empty field from a configured one", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  assert.deepEqual(
    policyPayload({
      requireChangesetReview: true,
      riskLevels: ["medium", "high", "critical"],
      protectedPaths: "secrets/**\n\n  infra/*.tf  \n",
      approvalTimeoutMinutes: "30",
      maxTaskRuntimeMinutes: "15",
      maxProjectRuntimeMinutesPerDay: "600",
    }),
    {
      policy: {
        version: 1,
        approvals: {
          requireChangesetReview: true,
          riskLevels: ["medium", "high", "critical"],
          protectedPaths: ["secrets/**", "infra/*.tf"],
          approvalTimeoutMs: 30 * 60_000,
        },
        budgets: {
          maxTaskRuntimeMs: 15 * 60_000,
          maxProjectRuntimeMsPerDay: 600 * 60_000,
        },
      },
    },
  );

  // Budgets alone must not drag an empty approvals object along with them.
  assert.deepEqual(policyPayload({ maxTaskRuntimeMinutes: "5" }), {
    policy: { version: 1, budgets: { maxTaskRuntimeMs: 300_000 } },
  });
});

test("the policy form can explicitly enable unattended execution", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  assert.deepEqual(
    policyPayload({
      approvalsEnabled: false,
      requireChangesetReview: true,
      riskLevels: ["low", "medium", "high", "critical"],
      protectedPaths: "package.json",
    }),
    {
      policy: {
        version: 1,
        approvals: { enabled: false },
      },
    },
  );
});

test("the policy form can keep critical gates without generic schema pauses", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  assert.deepEqual(
    policyPayload({
      requireSchemaReview: false,
      riskLevels: ["critical"],
      protectedPaths: "authentication/**\ndatabase/migrations/**\nsecrets/**",
    }),
    {
      policy: {
        version: 1,
        approvals: {
          requireSchemaReview: false,
          riskLevels: ["critical"],
          protectedPaths: [
            "authentication/**",
            "database/migrations/**",
            "secrets/**",
          ],
        },
      },
    },
  );
});

test("selecting exactly the default risk levels stores nothing", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  // Order must not matter; the default is a set, not a sequence.
  assert.deepEqual(policyPayload({ riskLevels: ["critical", "high"] }), {
    policy: null,
  });
  assert.deepEqual(policyPayload({ riskLevels: ["high"] }), {
    policy: { version: 1, approvals: { riskLevels: ["high"] } },
  });
});

test("the policy form refuses a runtime budget that is not a positive integer", async () => {
  const policyPayload = extract<(input: PolicyInput) => PolicyBody>(
    await browserSource(),
    "policyPayload",
    "minutesValue",
  );

  // Zero would be silently accepted by a truthiness check and would mean
  // "every task is instantly over budget".
  assert.throws(
    () => policyPayload({ maxTaskRuntimeMinutes: "0" }),
    /whole number of minutes/u,
  );
  assert.throws(
    () => policyPayload({ approvalTimeoutMinutes: "-5" }),
    /whole number of minutes/u,
  );
  assert.throws(
    () => policyPayload({ maxProjectRuntimeMinutesPerDay: "soon" }),
    /whole number of minutes/u,
  );
});

test("the browser date formatter supports full and compact timestamps", async () => {
  const source = await browserSource();
  const start = source.indexOf("function formatDate");
  const end = source.indexOf("\nfunction shortId", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const createFormatter = new Function(
    `${source.slice(start, end)}\nreturn formatDate;`,
  );
  const formatDate = createFormatter() as (
    value: string,
    options?: { short?: boolean },
  ) => string;
  const timestamp = "2026-07-27T12:34:00.000Z";

  assert.doesNotThrow(() => formatDate(timestamp));
  assert.doesNotThrow(() => formatDate(timestamp, { short: true }));
  assert.equal(formatDate("invalid"), "invalid");
});

test("repository creation and execution terminology are present in the product surface", async () => {
  const source = await browserSource();
  assert.match(source, /data-form="repository-create"/u);
  assert.match(source, /Create repository/u);
  assert.match(source, /Git commits remain in Repository History/u);
  assert.match(source, /label: "Executions"/u);
});

test("organization and project context is limited to the Home view", async () => {
  const source = await browserSource();
  assert.match(source, /\$\("#context-block"\)\.hidden = !\(/u);
  assert.match(source, /tab\?\.kind === "view" && tab\.view === "overview"/u);
});

test("first-run setup is exposed only while the control plane needs an owner", async () => {
  const source = await browserSource();
  assert.match(
    source,
    /bootstrapTab\.hidden = !state\.health\.setupRequired/u,
  );
  assert.match(
    source,
    /state\.health\.setupRequired[\s\S]*setAuthMode\("bootstrap"\)[\s\S]*setAuthMode\("login"\)/u,
  );
});

type DispatchInput = {
  adapter?: string;
  agents?: Array<{ id: string; adapter: string }>;
  workers?: Array<{ adapters?: string[] }>;
  repositoryId?: string;
  draft?: string;
  lastUserMessage?: string;
  route?: string;
};
type DispatchResult = {
  ok: boolean;
  reason?: string;
  warning?: string;
  objective: string;
  route: string;
  agentId?: string;
  repositoryId: string;
  workerCount: number;
};

async function dispatchPlanner(): Promise<
  (input: DispatchInput) => DispatchResult
> {
  return extract<(input: DispatchInput) => DispatchResult>(
    await browserSource(),
    "dispatchPlan",
    "currentDispatchPlan",
  );
}

const CLAUDE_AGENTS = [
  { id: "claude", adapter: "claude" },
  { id: "codex", adapter: "codex" },
];

test("dispatch prefers the machine that advertises the adapter", async () => {
  const dispatchPlan = await dispatchPlanner();
  // A desktop running the worker daemon with its own Claude login is the
  // point of the fleet: the phone submits, the desktop executes.
  const withDesktop = dispatchPlan({
    adapter: "claude",
    agents: CLAUDE_AGENTS,
    workers: [{ adapters: ["claude", "codex"] }],
    repositoryId: "core",
    draft: "Add a health endpoint",
  });
  assert.equal(withDesktop.ok, true);
  assert.equal(withDesktop.route, "remote");
  assert.equal(withDesktop.agentId, "claude");

  // With nobody listening, the control plane is the only thing that can run
  // it, so that is the default rather than a queue nothing will drain.
  const alone = dispatchPlan({
    adapter: "claude",
    agents: CLAUDE_AGENTS,
    repositoryId: "core",
    draft: "Add a health endpoint",
  });
  assert.equal(alone.route, "local");

  const codex = dispatchPlan({
    adapter: "codex",
    agents: CLAUDE_AGENTS,
    workers: [{ adapters: ["codex"] }],
    repositoryId: "core",
    draft: "Add a health endpoint",
  });
  assert.equal(codex.route, "remote");
  assert.equal(codex.agentId, "codex");

  // An explicit choice beats the per-provider default in both directions.
  assert.equal(
    dispatchPlan({
      adapter: "codex",
      agents: CLAUDE_AGENTS,
      repositoryId: "core",
      draft: "x",
      route: "local",
    }).route,
    "local",
  );
});

test("a remote dispatch with no worker listening says so instead of looking started", async () => {
  const dispatchPlan = await dispatchPlanner();
  // Choosing remote explicitly with nobody listening must still be honest.
  const alone = dispatchPlan({
    adapter: "codex",
    agents: CLAUDE_AGENTS,
    repositoryId: "core",
    draft: "Add a health endpoint",
    route: "remote",
  });
  assert.equal(alone.ok, true);
  assert.equal(alone.workerCount, 0);
  assert.match(alone.warning ?? "", /no remote worker/iu);

  const staffed = dispatchPlan({
    adapter: "codex",
    agents: CLAUDE_AGENTS,
    workers: [{ adapters: ["codex", "claude"] }, { adapters: ["gemini"] }],
    repositoryId: "core",
    draft: "Add a health endpoint",
  });
  assert.equal(staffed.workerCount, 1);
  assert.equal(staffed.warning, undefined);

  // A local run never depends on the worker fleet.
  assert.equal(
    dispatchPlan({
      adapter: "claude",
      agents: CLAUDE_AGENTS,
      repositoryId: "core",
      draft: "x",
    }).warning,
    undefined,
  );
});

test("dispatch falls back to the last message and refuses what it cannot submit", async () => {
  const dispatchPlan = await dispatchPlanner();
  // An empty composer dispatches what was last asked, so the conversation
  // itself becomes the task.
  assert.equal(
    dispatchPlan({
      adapter: "claude",
      agents: CLAUDE_AGENTS,
      repositoryId: "core",
      draft: "   ",
      lastUserMessage: "Explain and then fix the flaky test",
    }).objective,
    "Explain and then fix the flaky test",
  );

  assert.match(
    dispatchPlan({
      adapter: "claude",
      agents: CLAUDE_AGENTS,
      repositoryId: "core",
    }).reason ?? "",
    /type or send something/iu,
  );
  assert.match(
    dispatchPlan({
      adapter: "claude",
      agents: CLAUDE_AGENTS,
      draft: "x",
    }).reason ?? "",
    /repository/iu,
  );
  // No configured agent means no task: the coordinator would reject it.
  assert.match(
    dispatchPlan({
      adapter: "gemini",
      agents: CLAUDE_AGENTS,
      repositoryId: "core",
      draft: "x",
    }).reason ?? "",
    /adapter "gemini"/iu,
  );
});

test("a task routed to a remote worker is never drained by the local run loop", async () => {
  const source = await browserSource();
  // Without this guard the dashboard kicks a local run for any waiting chat
  // task, which claims the task in process and defeats the remote route.
  assert.match(source, /entry\.route !== "remote" &&/u);
  const drain = source.slice(
    source.indexOf("function maybeDrainChatRuns"),
    source.indexOf("function", source.indexOf("function maybeDrainChatRuns") + 10),
  );
  assert.match(drain, /route !== "remote"/u);
});

test("dispatch submits through the ordinary task endpoint, not a side channel", async () => {
  const source = await browserSource();
  const dispatch = source.slice(
    source.indexOf("async function performDispatch"),
    source.indexOf("Kicks the coordinator for a repository"),
  );
  assert.match(dispatch, /\/projects\/\$\{encodeURIComponent\(state\.projectId\)\}\/tasks/u);
  // Only the local route asks this control plane to execute.
  assert.match(dispatch, /plan\.route === "local"[\s\S]*ensureRepositoryRun/u);
});

test("the fleet is fetched for the organization, not the signed-in user", async () => {
  const source = await browserSource();
  // Worker visibility is org-wide, so both fleet reads must name the
  // organization. The gateway refuses an unscoped call outright; a client that
  // dropped the parameter would render an empty Coordination view rather than
  // fail loudly, so pin it here.
  assert.match(
    source,
    /\/workers\?organizationId=\$\{encodeURIComponent\(state\.organizationId\)\}/u,
  );
  assert.match(source, /agents\/running\?organizationId=\$\{encodeURIComponent\(/u);
  // The fleet spans colleagues now, so the table has to say whose worker each
  // row is rather than implying they are all the viewer's.
  assert.match(source, /function workerOwner/u);
  assert.match(source, /<th>Owner<\/th>/u);
});

test("the HUD reports agents running from the control plane's own count", async () => {
  const source = await browserSource();
  // Counted from active leases server-side; the client must not invent a
  // number from worker registrations, which are idle most of the time.
  assert.match(source, /agents\/running/u);
  assert.match(source, /agents\.busyWorkers/u);
  // A dial that has not heard from the control plane says so instead of
  // rendering a confident zero.
  assert.match(source, /agents === undefined \? "—" : running/u);
  assert.match(source, /Awaiting the control plane/u);
});

test("every HUD link indicator follows the WebSocket lifecycle", async () => {
  const source = await browserSource();
  assert.match(source, /function syncHudSocketIndicators/u);
  assert.match(
    source,
    /addEventListener\("open"[\s\S]*syncHudSocketIndicators\("live"\)/u,
  );
  assert.match(
    source,
    /addEventListener\("close"[\s\S]*syncHudSocketIndicators\("connecting"\)/u,
  );
  assert.match(source, /data-hud-socket-label="top"/u);
  assert.match(source, /data-hud-socket-label="compact"/u);
  assert.match(source, /data-hud-socket-label="detail"/u);
});

test("only the Home view drops the frame for the immersive HUD", async () => {
  const source = await browserSource();
  // The activity bar, sidebar, and chat dock disappear on Home alone; every
  // other view keeps the ordinary frame.
  assert.match(
    source,
    /"hud-immersive",\s*tab\?\.kind === "view" && tab\.view === "overview"/u,
  );
  // The bottom dock is built from the same ACTIVITIES lists the activity bar
  // renders, so labels, badges, and admin gating stay defined once.
  assert.match(
    source,
    /hudDock[\s\S]*\[\.\.\.ACTIVITIES, \.\.\.FOOTER_ACTIVITIES\]/u,
  );
  assert.match(source, /entry\.id !== "admin" \|\| state\.principal\?\.user\?\.systemAdmin/u);
});

test("every HUD dial draws its arc from a reported share, never decoration", async () => {
  const source = await browserSource();
  const gaugeSource = source.slice(
    source.indexOf("function gauge("),
    source.indexOf("function neuralCore("),
  );
  // A missing or zero denominator produces an empty arc, not a full one.
  assert.match(gaugeSource, /whole > 0 \? Math\.max\(0, Math\.min\(1, part \/ whole\)\) : 0/u);
  // The centerpiece's only data channel is its breathing period, set from
  // agents executing plus tasks the coordinator has claimed.
  assert.match(source, /--pulse:\$\{period\}s/u);
  assert.match(source, /const load = running \+ claimed/u);
});

type CoreSatelliteInput = {
  audit?: Array<{ event?: { type?: string } }>;
  runs?: Array<{ status?: string }>;
};
type CoreSatelliteStat = {
  position: string;
  label: string;
  value: number;
  context: string;
  view: string;
};

test("the core satellites expose real telemetry not repeated in the main readouts", async () => {
  const source = await browserSource();
  const coreSatelliteStats = extract<
    (input?: CoreSatelliteInput) => CoreSatelliteStat[]
  >(source, "coreSatelliteStats", "hudCoreSatellites");

  const stats = coreSatelliteStats({
    audit: [
      { event: { type: "plan_revised" } },
      { event: { type: "task_submitted" } },
      { event: { type: "plan_revised" } },
      { event: { type: "scope_change_requested" } },
    ],
    runs: [
      { status: "completed" },
      { status: "failed" },
      { status: "failed" },
      { status: "running" },
    ],
  });

  assert.deepEqual(
    stats.map(({ label, value, view }) => ({ label, value, view })),
    [
      { label: "Plan revisions", value: 2, view: "coordination" },
      { label: "Scope requests", value: 1, view: "coordination" },
      { label: "Failed runs", value: 2, view: "runs" },
      { label: "Audit depth", value: 4, view: "coordination" },
    ],
  );
  assert.match(source, /data-hud-satellite="\$\{position\}"/u);
  assert.match(source, /class="hud-core-satellites"[\s\S]*role="group"/u);
  assert.match(source, /tabindex="0"/u);
  assert.match(source, /Hover or focus to reveal extended telemetry/u);
  assert.doesNotMatch(
    source,
    /<aside class="signal-banner warn" aria-label="Sandbox runtime warning">/u,
  );
  assert.match(source, /<span>Sandbox<\/span><strong>/u);
});

type TerminalSnapshot = {
  project?: { name?: string };
  socket?: { readyState?: number };
  health?: { docker?: { available?: boolean } };
  tasks?: Array<{ status?: string }>;
  runs?: Array<{ status?: string }>;
  approvals?: Array<{ status?: string }>;
  repositories?: Array<{ id: string; branch?: string }>;
};

type TerminalProductResult = {
  handled: boolean;
  clear?: boolean;
  view?: string;
  lines: Array<{ kind: string; text: string }>;
};

test("the terminal keeps product commands useful without a sandbox", async () => {
  const source = await browserSource();
  const terminalProductCommand = extract<
    (command: string, snapshot: TerminalSnapshot) => TerminalProductResult
  >(source, "terminalProductCommand", "renderTerminalContext");
  const snapshot = {
    project: { name: "Relay" },
    socket: { readyState: 1 },
    health: { docker: { available: false } },
    tasks: [{ status: "claimed" }, { status: "submitted" }],
    runs: [{ status: "completed" }, { status: "failed" }],
    approvals: [{ status: "pending" }],
    repositories: [{ id: "relay", branch: "main" }],
  };

  assert.deepEqual(
    terminalProductCommand("tasks", snapshot).lines.map((line) => line.text),
    ["Tasks: claimed 1 | submitted 1"],
  );
  assert.match(
    terminalProductCommand("status", snapshot).lines
      .map((line) => line.text)
      .join("\n"),
    /Sandbox: offline/u,
  );
  assert.equal(terminalProductCommand("open tasks", snapshot).view, "board");
  assert.equal(terminalProductCommand("clear", snapshot).clear, true);
  assert.equal(terminalProductCommand("git status", snapshot).handled, false);
});

test("the HUD uses real counter-rotating machinery with a reduced-motion fallback", async () => {
  const source = await hudStyleSource();
  const browser = await browserSource();
  assert.match(browser, /src="\/hud-reactor-rotor\.png"/u);
  assert.doesNotMatch(source, /hud-plate-drift/u);
  assert.match(source, /hud-plate-energy 6\.4s/u);
  assert.match(source, /hud-rotor-clockwise 34s linear infinite/u);
  assert.match(source, /hud-rotor-counter 19s linear infinite/u);
  assert.match(
    source,
    /@keyframes hud-rotor-clockwise[\s\S]*rotate\(360deg\)/u,
  );
  assert.match(
    source,
    /@keyframes hud-rotor-counter[\s\S]*rotate\(0deg\)/u,
  );
  assert.match(
    source,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.hud-reactor-rotor[\s\S]*animation: none/u,
  );
});

test("the dispatch panel has a trigger that exists and is reachable", async () => {
  // The panel was dead code for a release: its only trigger was a composer
  // button removed in 7221fa1, and renderDispatchPanel early-returned when
  // that button was null, so nothing could open it. Both the markup hook and
  // the render guard are asserted here so the pairing cannot silently rot
  // again.
  const source = await browserSource();
  const markup = await readFile(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      "public",
      "index.html",
    ),
    "utf8",
  );

  assert.equal(
    source.includes('#chat-dispatch'),
    false,
    "the removed composer button must not be referenced again",
  );
  assert.match(
    source,
    /action: "dispatch-open"/u,
    "the fleet dial must carry the dispatch trigger",
  );
  assert.match(
    source,
    /target\.dataset\.action === "dispatch-open"/u,
    "the trigger must be handled on click, which is the tap path",
  );
  assert.match(
    source,
    /\(hover: hover\) and \(pointer: fine\)/u,
    "hover must be gated on a pointer that can actually hover",
  );

  // The panel lives outside the chat aside because the immersive Home view
  // hides that aside, and Home is where the trigger is.
  const layerAt = markup.indexOf('id="dispatch-layer"');
  const asideEndsAt = markup.indexOf("</aside>");
  assert.notEqual(layerAt, -1, "the dispatch layer must exist in the markup");
  assert.equal(
    layerAt > asideEndsAt,
    true,
    "the dispatch layer must not be nested in the chat aside",
  );
});

test("a build prompt only kicks the control plane when it is running it", async () => {
  // sendBuildPrompt used to call ensureRepositoryRun unconditionally, which
  // claimed the task locally before any worker could lease it — a connected
  // fleet would sit idle while the phone's task ran on the control plane.
  const source = await browserSource();
  const start = source.indexOf("async function sendBuildPrompt");
  assert.notEqual(start, -1, "sendBuildPrompt was not found in app.js");
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.match(
    body,
    /dispatchPlan\(/u,
    "build submission must decide its route the same way dispatch does",
  );
  assert.match(
    body,
    /plan\.route === "local"[\s\S]*ensureRepositoryRun/u,
    "the local kick must be guarded by the route",
  );
  assert.match(
    body,
    /route: plan\.route/u,
    "the tracked entry must record its route so refreshes do not drain it",
  );
});
