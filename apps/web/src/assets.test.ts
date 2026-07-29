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
  const assets = await loadStaticAssets(undefined, false);
  assert.equal(assets.get("/app.js") !== undefined, true);
  assert.equal(assets.get("/vendor/monaco/vs/loader.js"), undefined);
});

async function browserSource(): Promise<string> {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  return await readFile(path.join(packageRoot, "public", "app.js"), "utf8");
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

test("dispatch routes Claude in process and Codex to a remote worker", async () => {
  const dispatchPlan = await dispatchPlanner();
  const claude = dispatchPlan({
    adapter: "claude",
    agents: CLAUDE_AGENTS,
    repositoryId: "core",
    draft: "Add a health endpoint",
  });
  assert.equal(claude.ok, true);
  assert.equal(claude.route, "local");
  assert.equal(claude.agentId, "claude");

  const codex = dispatchPlan({
    adapter: "codex",
    agents: CLAUDE_AGENTS,
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
  const alone = dispatchPlan({
    adapter: "codex",
    agents: CLAUDE_AGENTS,
    repositoryId: "core",
    draft: "Add a health endpoint",
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

