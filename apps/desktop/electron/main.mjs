/**
 * The window, and nothing else.
 *
 * Kumi's dashboard is plain ES modules served by the control plane, so the app
 * does not ship a copy of it — it loads the deployment it was pointed at, the
 * way a browser would. That is what keeps shipping a change to the UI the same
 * one-step deploy it is today: a new installer is only ever needed when this
 * file changes, which is rarely.
 *
 * Deliberately plain JavaScript and deliberately outside the TypeScript
 * project. The monorepo's build is the deploy pipeline, and a workspace that
 * needs Electron installed to compile would put a desktop dependency between
 * the server and production. Install Electron where you develop the app —
 * `npm i -D electron` inside this package — and run `npm run desktop`.
 */

import { app, BrowserWindow, safeStorage, shell } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signIn } from "../dist/sign-in.js";

const here = path.dirname(fileURLToPath(import.meta.url));

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
      // Decrypted only here, and only on the machine that sealed it: OS-backed
      // keys, so copying the file to another laptop yields nothing readable.
      token:
        typeof sealed === "string" && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(sealed, "base64"))
          : "",
    };
  } catch {
    return { server: "", token: "" };
  }
}

async function writeSettings(server, token) {
  await mkdir(path.dirname(settingsPath()), { recursive: true });
  const sealed = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString("base64")
    : undefined;
  await writeFile(
    settingsPath(),
    JSON.stringify({ server, ...(sealed === undefined ? {} : { token: sealed }) }),
    "utf8",
  );
}

async function openDashboard(server, token) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(here, "preload.mjs"),
      // The page is a remote document. It gets no Node, and no reach into this
      // process beyond the two values the preload exposes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--kumi-server=${server}`,
        `--kumi-token=${token}`,
      ],
    },
  });
  // Anything the dashboard wants to open elsewhere opens in the real browser
  // rather than a second chromeless window nobody can read the address of.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // The dashboard's address, not the bare origin: the deployment serves its
  // marketing site at "/" now, and a chromeless window showing a sales page
  // with no way to sign in is what this line would otherwise open. Installers
  // built before this change still load "/" — the marketing page detects the
  // preload's KUMI_SERVER global and forwards itself to /app, so old installs
  // land in the dashboard too, one redirect later.
  await window.loadURL(new URL("/app", server).toString());
  return window;
}

app.whenReady().then(async () => {
  const server = process.env.KUMI_SERVER ?? (await readSettings()).server;
  if (server === "") {
    throw new Error(
      "No server configured. Start with KUMI_SERVER=https://your-kumi npm run desktop",
    );
  }
  let { token } = await readSettings();
  if (token === "") {
    // First launch: the browser is where signing in happens, because that is
    // where the session already is and where a person can read what they are
    // approving.
    const result = await signIn({
      server,
      appName: `Kumi on ${app.getPath("home").split(path.sep).pop() ?? "this machine"}`,
      openBrowser: async (url) => await shell.openExternal(url),
    });
    token = result.token;
    await writeSettings(server, token);
  }
  await openDashboard(server, token);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
