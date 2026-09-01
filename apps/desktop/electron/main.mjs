/**
 * The window, and the small amount of care a downloadable build needs.
 *
 * Kumi's dashboard is plain ES modules served by the control plane, so the app
 * does not ship a copy of it — it loads the deployment it was pointed at, the
 * way a browser would. That is what keeps shipping a change to the UI the same
 * one-step deploy it is today: a new installer is only ever needed when this
 * file changes, which is rarely.
 *
 * What is here beyond the window exists because this is something people
 * double-click rather than something started from a shell with a variable set.
 * There is no terminal to read an error out of and no environment to configure
 * a server in, so the app has to ask, has to say what went wrong, and has to
 * offer a way back out of a state it cannot recover from on its own.
 *
 * Deliberately plain JavaScript and deliberately outside the TypeScript
 * project. The monorepo's build is the deploy pipeline, and a workspace that
 * needs Electron installed to compile would put a desktop dependency between
 * the server and production. Install Electron where you develop the app —
 * `npm i -D electron` inside this package — and run `npm run desktop`.
 */

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signIn } from "../dist/sign-in.js";
import {
  normalizeServer,
  resolveServer,
  verifyServer,
} from "../dist/server-address.js";
// Imported, which it was not. `detectAgents` was called by the handler the
// dashboard asks "what is installed here" and by the menu that reports it,
// and was never brought into this module — so both threw ReferenceError on
// every call, on every launch, since the day the handler was written.
//
// Nothing said so. The renderer's `.catch(() => undefined)` turned the throw
// into "no answer", and the setup that answer gates — the CLI check, the
// install offer, the sign-in — was skipped in silence. Agents connected,
// looked connected, and could run nothing.
import { detectAgents } from "./agents.mjs";
import { setStayAwake, startWorker, stopWorker } from "./worker.mjs";
import { readVendorUsage } from "./usage.mjs";
import {
  INSTALLABLE_VENDORS,
  VENDOR_LABELS,
  installPlan,
  openSignIn,
  runInstall,
} from "./installers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Where installers are published, named once in `package.json` so the release
// workflow and this menu item cannot disagree about it. The address a shipped
// copy sends people to for a newer one is baked into every copy, so there has
// to be exactly one place it can be wrong.
const manifest = createRequire(import.meta.url)("../package.json");

// How the deployment tells this app apart from a browser on the same machine,
// so it can send desktop browsers to the installer and let the app through.
// Appended rather than replacing the User-Agent: the string still has to say
// Chromium, because everything that sniffs it downstream — the dashboard
// included — is entitled to know what it is actually talking to.
//
// A signpost and not a lock. Anybody can copy this marker out of their own
// install; what protects the hosting bill is the control plane refusing to
// execute agents, not this.
app.userAgentFallback = `${app.userAgentFallback} KumiDesktop/${
  manifest.version ?? "0"
}`;
const releasesUrl =
  typeof manifest.kumi?.releasesRepo === "string"
    ? `https://github.com/${manifest.kumi.releasesRepo}/releases`
    : undefined;

// The deployment this build was made for. Present in a build of the hosted
// product, where asking each person to name the server would be asking them
// something only one answer fits; absent in a build for self-hosting, which
// asks. Left blank rather than removed so the slot is visible.
const defaultServer = manifest.kumi?.defaultServer;

/** Set once sign-in is done; what every window after that is opened with. */
let session;
/** Whether a dashboard has been shown, which is what makes closing one a quit. */
let running = false;
/** Mirrors the stored `keepAwake` choice so the menu can show it. */
let awakeForWork = false;
/** What the menu says about the worker. Replaced as soon as one reports. */
let workerStatus = "Starting agents on this machine…";

/** Where the server address and the token live between launches. */
function settingsPath() {
  return path.join(app.getPath("userData"), "kumi.json");
}

async function readSettings() {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const saved = JSON.parse(raw);
    const sealed = saved.token;
    return {
      server: typeof saved.server === "string" ? saved.server : "",
      // Written by "Change Server" and cleared by choosing one. Without it, a
      // build with a baked-in address would fall straight back to it.
      askedToChange: saved.askedToChange === true,
      // Off unless it was turned on. Running agents spends this person's own
      // model quota on their own hardware, so it is volunteered rather than
      // assumed by an app they installed to get a window.
      // Staying awake is still a choice. Running agents is not: this app
      // exists to be the machine that runs them, and the deployment it talks
      // to may well refuse to run anything itself — an off switch there would
      // only ever mean "nothing happens anywhere", which is not a state worth
      // offering somebody a checkbox for.
      keepAwake: saved.keepAwake === true,
      // Decrypted only here, and only on the machine that sealed it: OS-backed
      // keys, so copying the file to another laptop yields nothing readable.
      token:
        typeof sealed === "string" && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(sealed, "base64"))
          : "",
    };
  } catch {
    return {
      server: "",
      token: "",
      askedToChange: false,
      keepAwake: false,
    };
  }
}

// `keepAwake` is threaded through every caller rather than defaulted, because
// the two writes on the startup path would otherwise clear the preference on
// each launch — the app would forget the choice every time it was opened.
async function writeSettings(
  server,
  token,
  askedToChange = false,
  keepAwake = false,
) {
  await mkdir(path.dirname(settingsPath()), { recursive: true });
  // An empty token is written as no token at all rather than as a sealed empty
  // string, so signing out leaves a file that plainly has nothing in it.
  const sealed =
    token !== "" && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString("base64")
      : undefined;
  await writeFile(
    settingsPath(),
    JSON.stringify({
      server,
      ...(sealed === undefined ? {} : { token: sealed }),
      ...(askedToChange ? { askedToChange: true } : {}),
      ...(keepAwake ? { keepAwake: true } : {}),
    }),
    "utf8",
  );
}

/** The first-run question. Resolves with an origin, or nothing if closed. */
async function askForServer() {
  let chosen;
  const window = new BrowserWindow({
    width: 460,
    height: 440,
    resizable: false,
    show: false,
    title: "Connect to Kumi",
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "setup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());

  ipcMain.handle("kumi:connect", async (_event, raw) => {
    const server = normalizeServer(raw);
    if (server === undefined) {
      return {
        ok: false,
        message: "That is not a web address. It should look like https://kumi.example.com.",
      };
    }
    const checked = await verifyServer(server);
    if (!checked.ok) {
      return checked;
    }
    chosen = server;
    // Closed after the answer has gone back, not during: a window destroyed
    // mid-reply leaves the page waiting on a promise nothing will settle. The
    // guard is for the case where somebody closed it themselves while the
    // address was still being checked.
    setImmediate(() => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });
    return { ok: true };
  });

  try {
    await window.loadFile(path.join(here, "setup.html"));
    await new Promise((resolve) => window.once("closed", resolve));
  } finally {
    ipcMain.removeHandler("kumi:connect");
  }
  return chosen;
}

/** What this machine will be called in the person's list of app tokens. */
/**
 * Whether this is a URL a browser should be asked to open.
 *
 * Parsed rather than string-matched, so `HTTPS:`, a scheme with padding, or
 * anything that merely begins with "http" is judged by what it resolves to.
 * A string that is not a URL at all is not one either.
 */
function opensInABrowser(candidate) {
  try {
    const { protocol } = new URL(candidate);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function deviceName() {
  const host = os.hostname().replace(/\.local$/u, "").trim();
  return `Kumi on ${host === "" ? "this machine" : host}`;
}

function relaunch() {
  app.relaunch();
  app.quit();
}

/**
 * The way back out of a state the app cannot fix by itself.
 *
 * A token revoked in Settings, or a deployment that has moved, leaves a
 * downloaded copy with a credential it cannot use and no shell to delete the
 * settings file from. Both of these forget exactly enough and start over.
 */
async function signOutAndRestart() {
  const { server, keepAwake } = await readSettings();
  await writeSettings(server, "", false, keepAwake);
  relaunch();
}

async function changeServerAndRestart() {
  // The token goes with the server: it was issued by that deployment and means
  // nothing to another one. The flag is what makes this menu item work at all
  // on a build that has an address baked in — see `resolveServer`.
  await writeSettings("", "", true);
  relaunch();
}

function buildMenu() {
  const help = [];
  if (releasesUrl !== undefined) {
    // Deliberately a link rather than an update that installs itself. These
    // builds are unsigned, and an unsigned app replacing its own binary is
    // something the operating system is right to refuse; pointing at the
    // downloads is honest about what is actually on offer.
    help.push({
      label: "Check for Updates…",
      click: () => void shell.openExternal(`${releasesUrl}/latest`),
    });
    help.push({ type: "separator" });
  }
  help.push(
    { label: "Sign Out and Restart", click: () => void signOutAndRestart() },
    { label: "Change Server…", click: () => void changeServerAndRestart() },
  );
  // Where a person volunteers this machine. Checkable rather than a dialog,
  // because the honest state is binary and they should be able to see which
  // one they are in without opening anything.
  const agents = [
    {
      // Shown, not offered. Whether agents run here is not a setting — but
      // whether they *are* running is a fact somebody needs, because the
      // reasons it can fail (no CLI signed in on this machine, an expired
      // credential) are all things only they can fix.
      label: workerStatus,
      enabled: false,
    },
    { type: "separator" },
    {
      // Named for what it actually does. The platform call underneath is
      // `SetThreadExecutionState`, and Microsoft is explicit that it "cannot
      // be used to prevent the user from putting the computer to sleep" — a
      // closed lid, the power button and Start > Sleep all go straight past
      // it. It stops the machine idling out, and nothing more, so the label
      // says idle rather than implying a promise it cannot keep.
      label: "Don't Sleep While Idle (plugged in, lid open)",
      type: "checkbox",
      checked: awakeForWork,
      click: (item) => void toggleKeepAwake(item.checked),
    },
  ];
  return Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" }]
      : [{ label: "File", submenu: [{ role: "quit" }] }]),
    // Edit and View are not decoration: the page is a remote document, and
    // without these there is no copy, no paste, and no way to reload it.
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: "Agents", submenu: agents },
    { role: "windowMenu" },
    { role: "help", submenu: help },
  ]);
}

/**
 * Turns this machine into a worker, or stops it being one.
 *
 * The answer is written down before the worker is started, so a crash on the
 * way up is still remembered as "yes" and retried next launch rather than
 * silently reverting. Anything that stops it from running says so in a dialog
 * — the failures are all actionable (no CLI installed, no organization, a
 * credential that has been revoked) and none of them are visible anywhere else
 * on a machine with no terminal open.
 */
/**
 * Offers this machine as one that stays up, or stops offering.
 *
 * Kept apart from the worker toggle because the two are different promises:
 * one is what the machine will do with its time, the other is what it will
 * give up to be reachable. Somebody may reasonably want to run agents all day
 * and still have their laptop sleep at night.
 */
async function toggleKeepAwake(wanted) {
  awakeForWork = wanted === true;
  // Said once, when the expectation is being formed. Somebody turning this on
  // is picturing a laptop working overnight, and the lid is exactly how they
  // would try it — better to be told now than to close it and find nothing
  // ran. The remedy is a system setting, and deliberately theirs to make: an
  // app that quietly rewrote what a person's lid does would be overstepping.
  if (awakeForWork) {
    await dialog.showMessageBox({
      type: "info",
      message: "This machine will stay awake while it is plugged in.",
      detail:
        "Closing the lid will still put it to sleep — no application can " +
        "override that. To keep working with the lid closed, set your " +
        "system's lid-close action to “Do nothing”.\n\nOn battery it " +
        "sleeps as usual, and agents wait until it is plugged in again.",
      buttons: ["OK"],
    });
  }
  const saved = await readSettings();
  await writeSettings(
    saved.server,
    saved.token,
    saved.askedToChange,
    awakeForWork,
  );
  setStayAwake(awakeForWork);
  Menu.setApplicationMenu(buildMenu());
}

/**
 * Keeps the menu's status line honest about what the worker is doing.
 *
 * Reported here rather than raised as a dialog, which is the difference
 * between a fact and an interruption. Starting is now unconditional, so a
 * machine with no agent CLI signed in would otherwise be told off by a modal
 * every single launch — for a condition it may well be fine with, on the
 * laptop it only uses to read threads from.
 */
function noteWorkerState(event) {
  workerStatus =
    event.state === "running"
      ? "Running agents on this machine"
      : event.state === "restarting"
        ? "Reconnecting…"
        : `Not running — ${event.detail}`;
  Menu.setApplicationMenu(buildMenu());
  if (event.reason === "no-cli") {
    void offerToInstallACli();
  }
}

/**
 * Whether this run has already offered to install a CLI.
 *
 * The worker restarts, and every restart on a machine with nothing installed
 * would ask again. Once per run is the right number: somebody who said no is
 * saying no to this session, not to the idea forever, and the offer is still
 * on the Agents screen whenever they want it.
 */
let offeredInstall = false;

/**
 * The dead end this app used to have, and the way out of it.
 *
 * Nothing here can run an agent until one of three vendors' CLIs is on the
 * machine, and the worker refuses to start without one — correctly, because a
 * worker advertising adapters it cannot drive takes work it will fail. But
 * refusing was the whole of it. The reason went into a menu, the dashboard
 * said nothing, and an agent connected from a machine in that state accepted
 * every task and did none of them.
 *
 * There was never a reason a person needed a CLI *first*. This app knows how
 * to install all three, has known since the install table was written, and
 * only ever offered it from a screen somebody had to go and find. So it asks
 * here, at the moment it discovers the gap, and installing takes effect
 * immediately: `runInstall`'s own handler stops and restarts the worker, so
 * the scan runs again and the machine starts advertising what it just got.
 */
async function offerToInstallACli() {
  if (offeredInstall || session === undefined || here === undefined) {
    return;
  }
  offeredInstall = true;
  const labels = INSTALLABLE_VENDORS.map(
    (vendor) => VENDOR_LABELS[vendor] ?? vendor,
  );
  const choice = await dialog.showMessageBox({
    type: "question",
    title: "Kumi needs an agent on this machine",
    message: "No agent CLI is installed here yet",
    detail:
      "Kumi runs agents on your own machine, under your own vendor login, so " +
      "one of these has to be installed before an agent can do any work. " +
      "Kumi can install it for you now — you will still sign in to the " +
      "vendor yourself afterwards.",
    buttons: [...labels, "Not now"],
    defaultId: 0,
    cancelId: labels.length,
    noLink: true,
  });
  const vendor = INSTALLABLE_VENDORS[choice.response];
  if (vendor === undefined) {
    return;
  }
  // The same path the dashboard uses, so there is one installer and one set of
  // commands rather than a second copy that drifts. Output is not relayed
  // anywhere here — there is no window asking — so a failure is reported as
  // its own message rather than as silence.
  const result = await runInstall(vendor, () => undefined);
  if (!result.ok) {
    dialog.showErrorBox(
      `Could not install ${VENDOR_LABELS[vendor] ?? vendor}`,
      `${result.detail ?? "The installer did not finish."}\n\n` +
        "You can install it yourself and restart Kumi, or try again from " +
        "Settings → Agents in the dashboard.",
    );
    return;
  }
  // Installed, and the worker is already restarting behind this. The sign-in
  // is the one step nobody can do for somebody else: every vendor's login is
  // an interactive flow it owns, and the most this can do is put them in
  // front of it with nothing left to type.
  stopWorker();
  void startWorker(here, session, noteWorkerState);
  openSignIn(vendor);
}

async function openDashboard() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      // The page is a remote document. It gets no Node, and no reach into this
      // process beyond the two values the preload exposes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--kumi-server=${session.server}`],
    },
  });
  // Anything the dashboard wants to open elsewhere opens in the real browser
  // rather than a second chromeless window nobody can read the address of.
  //
  // Only http(s) reaches the operating system, and the reason is not
  // hypothetical. The sign-in flow claims a tab during the click that starts
  // it — `window.open("", "_blank")`, because a tab opened after the await
  // would be a blocked popup — and an empty URL arrives here as
  // `about:blank`. Forwarding that made Windows ask which application opens
  // `about:` links, on top of a sign-in the deny had already cancelled.
  //
  // The general form matters more than that one case: this handler takes a
  // URL from a *remote* document and asks the OS to open it, and the OS
  // launches whatever is registered for the scheme. An allowlist keeps that
  // to the two schemes a browser is the right answer for.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (opensInABrowser(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  running = true;
  try {
    // The dashboard's address, not the bare origin: the deployment serves its
    // marketing site at "/" now, and a chromeless window showing a sales page
    // with no way to sign in is what this line would otherwise open.
    // Installers built before this change still load "/" — the marketing
    // page detects the preload's KUMI_SERVER global and forwards itself to
    // /app, so old installs land in the dashboard too, one redirect later.
    await window.loadURL(new URL("/app", session.server).toString());
  } catch (error) {
    // The window is left open on purpose. It is blank, but its menu is how
    // somebody points the app somewhere else or reloads once the server is
    // back — quitting here would take that away.
    dialog.showErrorBox(
      "Could not open Kumi",
      `${session.server} did not answer.\n\n${describe(error)}\n\n` +
        "Try View → Reload, or Help → Change Server.",
    );
  }
  return window;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

async function start() {
  const saved = await readSettings();
  let server = resolveServer({
    configured: process.env.KUMI_SERVER,
    saved: saved.server,
    fallback: defaultServer,
    askedToChange: saved.askedToChange,
  });
  // A token is only good at the deployment that issued it. Compared after
  // both sides are normalized, so a stored address that merely spells the
  // same origin differently does not throw away a working credential.
  let token =
    server !== undefined && server === normalizeServer(saved.server)
      ? saved.token
      : "";

  if (server === undefined) {
    server = await askForServer();
    if (server === undefined) {
      app.quit();
      return;
    }
    token = "";
    await writeSettings(server, token, false, saved.keepAwake);
  }

  if (token === "") {
    // The browser is where signing in happens, because that is where the
    // session already is and where a person can read what they are approving.
    try {
      const result = await signIn({
        server,
        appName: deviceName(),
        openBrowser: async (url) => await shell.openExternal(url),
      });
      token = result.token;
    } catch (error) {
      dialog.showErrorBox(
        "Could not sign in",
        `${describe(error)}\n\nStart Kumi again to try once more.`,
      );
      app.quit();
      return;
    }
    await writeSettings(server, token, false, saved.keepAwake);
  }

  session = { server, token };
  Menu.setApplicationMenu(buildMenu());
  // Started before the window rather than after it: a machine that was
  // volunteered should be answering for work as soon as it is running, not
  // once somebody looks at it.
  awakeForWork = saved.keepAwake === true;
  setStayAwake(awakeForWork);
  // Unconditional. The app is the machine that runs the agents; there is no
  // arrangement in which it has signed in and should be sitting idle.
  void startWorker(here, session, noteWorkerState);
  await openDashboard();
}

// Installing a vendor CLI, asked for by name.
//
// The renderer is a remote document, so it names a vendor and this process
// decides what that means — a command string never travels from the page to a
// shell. `installers.mjs` holds the table, and the plan the page displays is
// read back from it, so what somebody agrees to and what runs cannot differ.
ipcMain.handle("kumi:install-plan", (_event, vendor) => installPlan(vendor));

ipcMain.handle("kumi:install-run", async (event, vendor) => {
  const result = await runInstall(vendor, (line) => {
    // Relayed to the window that asked, as it arrives. These commands fail for
    // ordinary legible reasons and the vendor's own words say which; a spinner
    // that ends in "failed" would put the reader back where they began.
    if (!event.sender.isDestroyed()) {
      event.sender.send("kumi:install-output", line);
    }
  });
  if (result.ok && here !== undefined && session !== undefined) {
    // The scan deciding which agents this machine advertises runs at worker
    // start, so a CLI installed afterwards stays invisible until the worker
    // restarts. Doing it here is what lets an install take effect without
    // asking somebody to quit the app they are in the middle of using.
    stopWorker();
    void startWorker(here, session, noteWorkerState);
  }
  return result;
});

ipcMain.handle("kumi:install-sign-in", (_event, vendor) => openSignIn(vendor));

// What the vendor says is left, read here rather than on the control plane.
//
// The server's copy of this needed a stored vendor credential, and that
// credential was the whole reason connecting an agent asked for a second
// sign-in — nothing else wanted it, since the agent runs here under the login
// this machine already holds. Raw output goes back; the server parses it, and
// keeps the last reading so the figure survives this machine being asleep.
ipcMain.handle("kumi:agent-usage", async (_event, vendor) =>
  await readVendorUsage(vendor),
);

// What this machine actually has, asked for by the connect screen.
//
// The same scan the worker registers from, so the page and the worker cannot
// disagree about whether an agent can run here. Adapter ids, not paths: the
// page needs to know whether to offer an install, and has no business knowing
// where anything lives.
ipcMain.handle("kumi:machine-agents", async () =>
  Object.values(await detectAgents()).map((agent) => agent.adapter),
);

// The renderer asks for the token here instead of being handed it on its
// command line. Only the top frame of a window running our preload can reach
// this channel, which is the same set of pages that get the token anyway.
ipcMain.on("kumi:token", (event) => {
  event.returnValue = session?.token ?? "";
});

app.whenReady().then(start, (error) => {
  dialog.showErrorBox("Kumi could not start", describe(error));
  app.quit();
});

// A planned shutdown hands the lease back, so whatever this machine was
// holding is picked up again immediately instead of waiting out its expiry.
app.on("before-quit", () => {
  stopWorker();
});

app.on("window-all-closed", () => {
  // Not while starting up: the first-run window closes before the dashboard
  // opens, and on Windows and Linux that gap would otherwise end the app.
  if (process.platform !== "darwin" && running) {
    app.quit();
  }
});

app.on("activate", () => {
  if (session !== undefined && BrowserWindow.getAllWindows().length === 0) {
    void openDashboard();
  }
});
