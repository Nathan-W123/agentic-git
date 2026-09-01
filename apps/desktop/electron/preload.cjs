/**
 * The two values the dashboard needs to know it is not in a browser.
 *
 * `data.js` reads exactly these: without them it builds relative paths and
 * uses the session cookie, which is what every browser does and what the web
 * deployment keeps doing. With them it addresses the configured server and
 * carries a bearer token instead.
 *
 * Injected through `contextBridge` rather than written onto the page's own
 * globals: the renderer stays isolated, and nothing the page loads can reach
 * back into this process. Preloads run in the top frame only, so an iframe on
 * the page is not handed either value.
 *
 * CommonJS, and the extension is load-bearing. A preload in a sandboxed
 * renderer cannot be an ES module — Electron does not run it and does not say
 * so, and the page comes up looking like an ordinary browser tab with no
 * server and no token. `.cjs` is what makes it run; the sandbox is worth
 * keeping, because the document this faces is remote.
 */

const { contextBridge, ipcRenderer } = require("electron");

function argument(name) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ??
    ""
  );
}

contextBridge.exposeInMainWorld("KUMI_SERVER", argument("kumi-server"));

// Asked for over IPC rather than read off this process's command line. A
// renderer's arguments are visible to anything that can list processes —
// `/proc/<pid>/cmdline` is world-readable on Linux — and a token legible to
// every other program on the machine would make sealing it on disk pointless.
contextBridge.exposeInMainWorld("KUMI_TOKEN", ipcRenderer.sendSync("kumi:token"));

/**
 * Installing a vendor CLI, and getting signed into it, from the dashboard.
 *
 * Deliberately narrow. `install` takes a vendor *name* and the main process
 * decides what that means — this bridge cannot carry a command, so a remote
 * document cannot ask this machine to run one. `plan` reads back what would
 * run, so the confirmation the person sees is the thing that executes rather
 * than a second copy of it written in the page.
 *
 * Absent in a browser, which is how the dashboard knows not to offer any of
 * this: there, the command is shown to be copied and run by hand.
 */
contextBridge.exposeInMainWorld("KUMI_INSTALL", {
  plan: async (vendor) => await ipcRenderer.invoke("kumi:install-plan", vendor),
  run: async (vendor) => await ipcRenderer.invoke("kumi:install-run", vendor),
  signIn: async (vendor) =>
    await ipcRenderer.invoke("kumi:install-sign-in", vendor),
  // Which agents this machine can actually drive, so the connect screen can
  // finish the job rather than leaving somebody to discover the gap when they
  // first @mention the agent they just connected.
  detected: async () => await ipcRenderer.invoke("kumi:machine-agents"),
  // How much of the vendor's quota is left, asked of the CLI that holds the
  // login rather than of a credential copied to a server. This is what makes
  // the second sign-in unnecessary: the account is already signed in here.
  usage: async (vendor) => await ipcRenderer.invoke("kumi:agent-usage", vendor),
  // One listener per call site, removed by the returned function, so a page
  // that opens the dialog repeatedly does not accumulate them.
  onOutput: (listener) => {
    const relay = (_event, line) => listener(String(line));
    ipcRenderer.on("kumi:install-output", relay);
    return () => ipcRenderer.removeListener("kumi:install-output", relay);
  },
});
