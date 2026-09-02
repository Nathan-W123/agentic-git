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
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectAgents, ensureProject, exists } from "./agents.mjs";
import { askDialog } from "./dialog.mjs";
import { treeKill } from "./installers.mjs";
import {
  allowMcpServers,
  forgetMcpAllow,
  missingMcpServers,
  readAllowedMcp,
} from "./mcp-consent.mjs";

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
/**
 * The start already in flight, so a second caller joins it rather than racing.
 *
 * `child` is the obvious guard and it is not enough: it is assigned only after
 * five awaits — the bundle check, the agent scan, the tenancy lookup, the
 * project write — and there are three call sites. Two overlapping calls both
 * read `child` as undefined, both walk that gap, and both fork. The second
 * assignment then orphans the first child: it is still running, still
 * registered, still polling, and `stopWorker` can no longer reach it.
 *
 * A deployment accumulated more than fifty worker registrations for one
 * computer this way, in pairs a second apart, each one a machine the control
 * plane believed was available.
 */
let starting;
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
/**
 * The MCP servers this process has already asked about, and whether it is
 * asking right now.
 *
 * A worker runs several tasks at once and says what it withheld on every one
 * of them, so a project with one unallowed server on a busy afternoon would
 * put the same question up a dozen times — and a person who answered "not
 * now" once has answered. Remembered for the process's lifetime and no
 * longer: quitting the app is a reasonable way to be asked again, and the
 * "yes" side is written to disk, so it is only the "no" that is forgotten.
 */
const askedMcp = new Set();
let askingMcp = false;
/** What the project is called, for the question. */
let projectLabel = "This project";

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
  let projectName;
  try {
    const projects = await getJson(
      server,
      token,
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects`,
    );
    projectId = projects?.projects?.[0]?.id;
    projectName = projects?.projects?.[0]?.name;
  } catch {
    // Optional: the worker falls back to the default project, which is the
    // only one most deployments have.
  }
  return { organizationId, projectId, projectName };
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
  // Joined, not restarted. The whole body below is the critical section.
  if (starting !== undefined) {
    return await starting;
  }
  starting = startWorkerOnce(here, session, onEvent).finally(() => {
    starting = undefined;
  });
  return await starting;
}

async function startWorkerOnce(here, session, onEvent) {
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
    // Named, not just described. This is the one stop the app can do something
    // about — every other one is a crash, a bad token or a server that did not
    // answer — and until it carried a reason the only trace of it was a line
    // of text in a menu nobody opens. Somebody would install the app, connect
    // an agent, watch it accept work and never do any, and have no way at all
    // to find out that nothing on the machine could run it.
    onEvent?.({
      state: "stopped",
      reason: "no-cli",
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

  if (typeof tenancy.projectName === "string" && tenancy.projectName !== "") {
    projectLabel = tenancy.projectName;
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

  // Kept, as well as shown. The menu holds one line — the most recent — and
  // everything before it went nowhere, so the worker's account of a task was
  // gone by the time anybody thought to ask about it. That is exactly the
  // wrong shape for the questions this output answers: why a task was slow,
  // which phase it was slow in, what the CLI said before it gave up. None of
  // those are things somebody is watching the menu for when they happen.
  const log = await openWorkerLog();
  const heard = (line) => {
    const text = String(line);
    log?.write(text);
    onEvent?.({ state: "running", detail: text.trim() });
  };
  child.stdout?.on("data", heard);
  child.stderr?.on("data", heard);
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
    } else if (message?.type === "mcp-offered") {
      // The child ran without these and has said so to the room; the one
      // thing it cannot do is ask the person whose machine this is.
      void offerMcpConsent(message.servers, here, session, onEvent);
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
 * Asks the machine's owner whether a project's MCP servers may run here.
 *
 * The project has already said yes; that is why the lease carried them. But
 * "yes" from a project is a decision about its agents, and what is being
 * decided here is whether programs it chose start on this computer under
 * this person's account — which is theirs alone to say. The worker reads
 * the answer from its config once, at start, so a "yes" is followed by a
 * restart: otherwise the person would allow the servers and watch the next
 * ten tasks run without them anyway.
 *
 * Asked once per set of names, and never while a question is already up.
 * The list on disk is consulted every time rather than cached, because the
 * settings window can change it between two leases and asking about a
 * server that was allowed a minute ago would be asking twice.
 */
async function offerMcpConsent(servers, here, session, onEvent) {
  if (askingMcp || !Array.isArray(servers)) {
    return;
  }
  const root = workerRoot();
  let missing;
  try {
    missing = missingMcpServers(await readAllowedMcp(root), servers);
  } catch {
    return;
  }
  const key = missing.map((server) => `${server.name}@${server.digest}`).join("\n");
  if (missing.length === 0 || askedMcp.has(key)) {
    return;
  }
  askedMcp.add(key);
  askingMcp = true;
  let allowed = false;
  try {
    // What each one is, not just what it is called: the owner is agreeing
    // to a program or a URL, and a server that was allowed before and has
    // since been redefined is said to have changed, so a yes given to the
    // old definition is not mistaken for one given to the new.
    const lines = missing
      .map((server) => `• ${server.summary}${server.changed ? " (changed since you allowed it)" : ""}`)
      .join("\n");
    const choice = await askDialog({
      kind: "question",
      title: "Kumi",
      heading: "This project wants to run tools on this computer",
      body:
        `${projectLabel} has approved MCP servers for its agents:\n\n${lines}\n\n` +
        "Allowing them starts those programs on this computer, under your " +
        "account, whenever one of your agents runs a task here. To take " +
        "this back later, use Agents → Forget Allowed MCP Servers.",
      buttons: ["Allow these", "Not now"],
      cancelId: 1,
    });
    allowed = choice === 0;
  } catch {
    // A dialog that could not be shown is a question not asked; the set is
    // left remembered so a broken window does not become a loop.
  } finally {
    askingMcp = false;
  }
  if (!allowed) {
    return;
  }
  try {
    await allowMcpServers(root, missing);
  } catch (error) {
    onEvent?.({
      state: "running",
      detail: `Could not save the MCP allowlist: ${describe(error)}`,
    });
    return;
  }
  await restartForMcp(here, session, onEvent);
}

/**
 * The restart a change to the allowlist needs.
 *
 * `stopWorker` lets go of the stay-awake offer along with everything else,
 * because it is what a quit calls. This is not a quit, and the person's
 * answer to "keep this machine up for work" has not changed.
 */
async function restartForMcp(here, session, onEvent) {
  const keepAwake = stayAwake;
  stopWorker();
  await startWorker(here, session, onEvent);
  setStayAwake(keepAwake);
}

/**
 * Withdraws every MCP server this computer has allowed.
 *
 * The menu's half of the consent: a yes that could not be taken back from
 * the same app would be a yes given once and kept forever. The worker reads
 * the list at start, so it is restarted if it is running; the "not now"
 * answers this process remembered are forgotten too, so the next lease that
 * offers a server asks again.
 */
export async function forgetMcpServers(here, session, onEvent) {
  await forgetMcpAllow(workerRoot());
  askedMcp.clear();
  if (child === undefined) {
    return;
  }
  await restartForMcp(here, session, onEvent);
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
    // The whole tree, not just the worker.
    //
    // The worker is the parent of a vendor CLI that can run for an hour, and
    // on Windows killing a parent leaves its children running — nothing
    // inherits the kill. So every quit and every supervised restart orphaned
    // whatever agent was mid-run: it kept working, kept spending its owner's
    // quota, and kept holding the worktree it had checked out, with nothing
    // left that knew it existed. They accumulate one per restart, and a dozen
    // of them fighting over the same repository is indistinguishable from a
    // machine that has simply stopped working.
    terminateTree(child.pid);
    child.kill();
    child = undefined;
  }
}

/**
 * Ends a process and everything beneath it.
 *
 * `taskkill /t` is the only thing on Windows that walks the tree; POSIX gets
 * the process group, which `kill` already reaches. Best effort throughout —
 * this runs while the app is quitting, and a failure to clean up must not be
 * able to stop it.
 *
 * The argv comes from {@link treeKill} rather than being written out here.
 * This file had the full path to `taskkill.exe` from the start and the usage
 * reader did not, and a bare name there cost two Windows release jobs — so
 * there is now one rule and one place to be right about it.
 */
function terminateTree(pid) {
  const tree = pid === undefined ? undefined : treeKill(pid);
  if (tree === undefined) {
    return;
  }
  try {
    spawnSync(tree.command, tree.args, { windowsHide: true, stdio: "ignore" });
  } catch {
    // Nothing left to try, and nothing worth failing a quit over.
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

/** Where the worker's own account of itself is kept. */
export function workerLogPath() {
  return path.join(app.getPath("userData"), "worker.log");
}

/**
 * Opens the log, rolling it over once it gets long.
 *
 * One generation back is kept and no more. This is a diagnostic somebody
 * reads within minutes of noticing something, not an audit trail — and a file
 * that grows without bound on a machine running agents all day is a bug of its
 * own.
 */
async function openWorkerLog() {
  const file = workerLogPath();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const size = await stat(file)
      .then((info) => info.size)
      .catch(() => 0);
    if (size > MAX_LOG_BYTES) {
      await rename(file, `${file}.1`).catch(() => undefined);
    }
    const stream = createWriteStream(file, { flags: "a" });
    // A log that cannot be written is not worth failing a worker over.
    stream.on("error", () => undefined);
    stream.write(`\n--- ${new Date().toISOString()} worker started ---\n`);
    return stream;
  } catch {
    return undefined;
  }
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;
