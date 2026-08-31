/**
 * Running agents on this machine instead of on the control plane.
 *
 * The worker itself is not new and nothing here reimplements it: `apps/worker`
 * has spoken the remote worker protocol over HTTP for as long as there has
 * been one, and `docs/deployment/desktop-worker.md` documents driving it by
 * hand. What was missing was everything around it — a person had to mint a
 * token, write a `.coordinator/config.json`, and hold six environment
 * variables in their head. This supplies those from what the app already
 * knows, so the difference between a window onto a deployment and a machine
 * that runs its own work is a menu item.
 *
 * ### Why the credentials never move
 *
 * A worker executes under the vendor logins already sitting on this machine.
 * That is the entire point: the control plane never needs the operator's
 * Claude or Codex session, and a task submitted by someone else runs on their
 * hardware under their account, not here. The token handed to the child is the
 * app's own, which is scoped to this user and carries `run_task` — it grants
 * the right to ask for work, and nothing about anyone's vendor subscription.
 *
 * ### Off unless asked
 *
 * Deliberately opt-in. Installing a window onto a deployment should not
 * quietly start spending someone's model quota, and the machine is theirs to
 * volunteer. The choice is remembered, so it is asked exactly once.
 */
import { app, powerMonitor, powerSaveBlocker, utilityProcess } from "electron";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectAgents, ensureProject, exists } from "./agents.mjs";

/**
 * Backoff between restarts, and the point at which restarting is pointless.
 *
 * A worker that dies immediately is almost always misconfigured rather than
 * unlucky — no CLI installed, a revoked token — and hammering it neither fixes
 * that nor tells anyone about it. Runs that lasted a while reset the count,
 * because those are the ordinary crashes worth recovering from.
 */
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
const HEALTHY_RUN_MS = 60_000;

let child;
let stopping = false;
/** The id of the sleep block currently held, if any. */
let awake;
/** Whether a task is running right now. */
let busy = false;
/**
 * Whether this machine has been offered as one that stays up for work.
 *
 * The honest answer to "run while asleep" on Windows. Microsoft's position is
 * that "Windows prevents desktop applications from running during any part of
 * modern standby", and the one approved alternative — a packaged app's
 * background task — is capped at a few seconds of CPU every fifteen minutes on
 * AC only, which is sized for redrawing a tile rather than running an agent.
 * Since the machine cannot work while it sleeps, the only remaining lever is
 * for it not to sleep, and that is a decision for its owner to make out loud
 * rather than one to take on their behalf.
 */
let stayAwake = false;
let failures = 0;
let restartTimer;

/** Where the worker keeps its own project, worktrees and scratch space. */
function workerRoot() {
  return path.join(app.getPath("userData"), "worker");
}

/**
 * The bundle, wherever this copy is running from.
 *
 * Packaged builds get it from `extraResources`; a checkout gets it from the
 * path `npm run bundle:worker` writes to, so `npm run desktop` behaves the
 * same as an installed copy without a second code path to keep honest.
 */
function bundlePath(here) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "worker.cjs")
    : path.join(here, "..", "resources", "worker.cjs");
}

async function getJson(server, token, route) {
  const response = await fetch(new URL(route, server), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`${route} answered ${response.status}`);
  }
  return await response.json();
}

/**
 * The organization and project this machine should poll.
 *
 * Asked of the server rather than configured, because the app already holds a
 * credential that can answer it and a person should not have to know their own
 * organization's id to run an agent. A deployment with several is served by
 * the first, which is the only one a single-tenant install has.
 */
async function discoverTenancy(server, token) {
  const orgs = await getJson(server, token, "/api/v1/organizations");
  const organizationId = orgs?.organizations?.[0]?.id;
  if (typeof organizationId !== "string" || organizationId === "") {
    throw new Error("This account is not a member of any organization");
  }
  let projectId;
  try {
    const projects = await getJson(
      server,
      token,
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects`,
    );
    projectId = projects?.projects?.[0]?.id;
  } catch {
    // Optional: the worker falls back to the default project, which is the
    // only one most deployments have.
  }
  return { organizationId, projectId };
}

function scheduleRestart(here, session, onEvent, ranForMs) {
  if (stopping) {
    return;
  }
  failures = ranForMs >= HEALTHY_RUN_MS ? 0 : failures + 1;
  if (failures > RESTART_DELAYS_MS.length) {
    onEvent?.({
      state: "stopped",
      detail: "The worker kept exiting immediately and was not restarted.",
    });
    return;
  }
  const delay = RESTART_DELAYS_MS[Math.min(failures - 1, RESTART_DELAYS_MS.length - 1)];
  restartTimer = setTimeout(() => {
    void startWorker(here, session, onEvent);
  }, delay);
  restartTimer.unref?.();
}

/**
 * Starts the worker, or reports plainly why it cannot.
 *
 * Every failure here is one a person can act on — no agent installed, no
 * organization, no bundle — so none of them are swallowed. `onEvent` is how
 * the window says so out loud.
 */
export async function startWorker(here, session, onEvent) {
  if (child !== undefined) {
    return;
  }
  stopping = false;
  const bundle = bundlePath(here);
  if (!(await exists(bundle))) {
    onEvent?.({
      state: "stopped",
      detail: "This build shipped without a worker. Run `npm run bundle:worker`.",
    });
    return;
  }

  const agents = await detectAgents();
  if (Object.keys(agents).length === 0) {
    onEvent?.({
      state: "stopped",
      detail:
        "No agent CLI found on this machine. Install and sign in to Claude Code or Codex, then try again.",
    });
    return;
  }

  let tenancy;
  try {
    tenancy = await discoverTenancy(session.server, session.token);
  } catch (error) {
    onEvent?.({ state: "stopped", detail: describe(error) });
    return;
  }

  const root = workerRoot();
  await mkdir(root, { recursive: true });
  await ensureProject(root, agents);

  const startedAt = Date.now();
  child = utilityProcess.fork(bundle, [], {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      COORD_SERVER: session.server,
      COORD_TOKEN: session.token,
      COORD_ORGANIZATION: tenancy.organizationId,
      COORD_PROJECT_ROOT: root,
      COORD_WORKER_NAME: deviceName(),
      // What this machine actually has. The project config the worker reads
      // has a default agent backfilled for every vendor it lacks, so without
      // this the worker would register for Cursor and Kiro on a machine that
      // has neither, be offered their work, and fail it.
      COORD_WORKER_ADAPTERS: [
        ...new Set(Object.values(agents).map((agent) => agent.adapter)),
      ].join(","),
      ...(tenancy.projectId === undefined
        ? {}
        : { COORD_PROJECT_ID: tenancy.projectId }),
    },
  });

  child.stdout?.on("data", (line) => {
    onEvent?.({ state: "running", detail: String(line).trim() });
  });
  child.stderr?.on("data", (line) => {
    onEvent?.({ state: "running", detail: String(line).trim() });
  });
  // Held for the lease's lifetime and no longer. Sleeping halfway through an
  // agent's execution loses the work and strands the lease until it expires;
  // holding the machine open for as long as the worker is merely *enabled*
  // would mean volunteering a laptop stopped it ever sleeping again. The child
  // knows where that window starts and ends, so it says so.
  child.on("message", (message) => {
    if (message?.type === "busy") {
      busy = true;
      reconsiderAwake();
    } else if (message?.type === "idle") {
      busy = false;
      reconsiderAwake();
    }
  });

  child.once("exit", (code) => {
    busy = false;
    reconsiderAwake();
    const ranForMs = Date.now() - startedAt;
    child = undefined;
    if (stopping) {
      onEvent?.({ state: "stopped", detail: "Stopped." });
      return;
    }
    onEvent?.({ state: "restarting", detail: `Worker exited (${code}).` });
    scheduleRestart(here, session, onEvent, ranForMs);
  });

  onEvent?.({
    state: "running",
    detail: `Running ${Object.keys(agents).join(", ")} on this machine.`,
  });
}

/**
 * Stops the worker.
 *
 * A planned shutdown matters more here than it looks: the worker answers
 * SIGTERM by handing its lease back, so the task it was holding is picked up
 * again straight away instead of waiting out a five-minute expiry.
 */
/**
 * Holds the machine open while there is a reason to, and lets it go otherwise.
 *
 * Battery always wins. A laptop on its own power should sleep when it is idle
 * no matter what has been asked for, both because the worker declines to claim
 * on battery anyway and because silently flattening someone's battery is not a
 * trade this is entitled to make for them.
 */
function reconsiderAwake() {
  const onBattery = powerMonitor.isOnBatteryPower?.() === true;
  if (!onBattery && (busy || stayAwake)) {
    holdAwake();
  } else {
    releaseAwake();
  }
}

/** Offers this machine as one that stays up for work, or stops offering. */
export function setStayAwake(enabled) {
  stayAwake = enabled === true;
  reconsiderAwake();
}

function holdAwake() {
  if (awake !== undefined) {
    return;
  }
  // `prevent-app-suspension` keeps the system from sleeping while leaving the
  // display free to switch off, which is the right shape for work nobody is
  // watching. Electron supplies it on every platform, so this needs no native
  // code, no elevation and no service.
  awake = powerSaveBlocker.start("prevent-app-suspension");
}

function releaseAwake() {
  if (awake === undefined) {
    return;
  }
  if (powerSaveBlocker.isStarted(awake)) {
    powerSaveBlocker.stop(awake);
  }
  awake = undefined;
}

export function stopWorker() {
  stopping = true;
  busy = false;
  stayAwake = false;
  releaseAwake();
  if (restartTimer !== undefined) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  if (child !== undefined) {
    child.kill();
    child = undefined;
  }
}

// Unplugging must take the block away, and plugging in must be able to bring
// it back without waiting for the next task.
powerMonitor.on?.("on-battery", () => reconsiderAwake());
powerMonitor.on?.("on-ac", () => reconsiderAwake());

export function workerIsRunning() {
  return child !== undefined;
}

/** What this machine calls itself in the fleet listing. */
function deviceName() {
  const host = os.hostname().replace(/\.local$/u, "").trim();
  return host === "" ? "this machine" : host;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
