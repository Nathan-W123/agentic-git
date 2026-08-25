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
