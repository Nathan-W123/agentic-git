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
import { startWorker, stopWorker, workerIsRunning } from "./worker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Where installers are published, named once in `package.json` so the release
// workflow and this menu item cannot disagree about it. The address a shipped
// copy sends people to for a newer one is baked into every copy, so there has
// to be exactly one place it can be wrong.
const manifest = createRequire(import.meta.url)("../package.json");
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
      runAgents: saved.runAgents === true,
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
      runAgents: false,
    };
  }
}

// `runAgents` is threaded through every caller rather than defaulted, because
// the two writes on the startup path would otherwise clear the preference on
// each launch — the app would forget it had been volunteered as a worker every
// time it was opened.
async function writeSettings(
  server,
  token,
  askedToChange = false,
  runAgents = false,
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
      ...(runAgents ? { runAgents: true } : {}),
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
  const { server, runAgents } = await readSettings();
  // The machine keeps its role. Signing out replaces a credential; it does not
  // mean this person stopped volunteering their hardware.
  await writeSettings(server, "", false, runAgents);
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
      label: "Run Agents on This Machine",
      type: "checkbox",
      checked: workerIsRunning(),
      click: (item) => void toggleWorker(item.checked),
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
async function toggleWorker(wanted) {
  const saved = await readSettings();
  await writeSettings(saved.server, saved.token, saved.askedToChange, wanted);
  if (!wanted) {
    stopWorker();
    Menu.setApplicationMenu(buildMenu());
    return;
  }
  if (session === undefined) {
    return;
  }
  await startWorker(here, session, (event) => {
    if (event.state === "stopped" && event.detail !== "Stopped.") {
      dialog.showErrorBox("Kumi cannot run agents here", event.detail);
    }
    Menu.setApplicationMenu(buildMenu());
  });
  Menu.setApplicationMenu(buildMenu());
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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
    await writeSettings(server, token, false, saved.runAgents);
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
    await writeSettings(server, token, false, saved.runAgents);
  }

  session = { server, token };
  Menu.setApplicationMenu(buildMenu());
  // Started before the window rather than after it: a machine that was
  // volunteered should be answering for work as soon as it is running, not
  // once somebody looks at it.
  if (saved.runAgents) {
    void startWorker(here, session, () =>
      Menu.setApplicationMenu(buildMenu()),
    );
  }
  await openDashboard();
}

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
