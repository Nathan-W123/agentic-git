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

/** Kept in step with `editor-mcp.mjs`; a preload cannot import an ES module. */
const CONNECTABLE = ["claude", "codex", "cursor"];

function argument(name) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ??
    ""
  );
}

/**
 * Each value on its own, so one failure cannot take the others with it.
 *
 * A preload is one script: an exception part-way through stops everything
 * after it, silently, and the page comes up with whichever globals happened to
 * be exposed before the throw. That is not hypothetical here — the token is
 * fetched with a synchronous IPC call, and a synchronous call is exactly the
 * kind of thing that can fail on a machine nobody has tested: a handler not
 * yet registered, a renderer that reloaded, a channel closed under it.
 *
 * When that happened the page kept `KUMI_SERVER` and lost `KUMI_INSTALL`,
 * which is indistinguishable from an app too old to have the bridge at all.
 * Every agent connected from that window looked connected and could run
 * nothing: no CLI check, no install, no sign-in, and no way to find out why.
 * The failures are independent now, and a value that could not be read is
 * simply absent rather than fatal to the rest.
 */
function expose(name, build) {
  try {
    contextBridge.exposeInMainWorld(name, build());
  } catch (error) {
    // Reported where a preload's output goes — the main process's console —
    // rather than swallowed. A missing global has visible consequences in the
    // page, and this is the only place that can say which one went and why.
    process.stderr.write(
      `[preload] could not expose ${name}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

expose("KUMI_SERVER", () => argument("kumi-server"));

// Asked for over IPC rather than read off this process's command line. A
// renderer's arguments are visible to anything that can list processes —
// `/proc/<pid>/cmdline` is world-readable on Linux — and a token legible to
// every other program on the machine would make sealing it on disk pointless.
expose("KUMI_TOKEN", () => ipcRenderer.sendSync("kumi:token"));

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
expose("KUMI_INSTALL", () => ({
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
  /**
   * Points one editor on this machine at this Kumi.
   *
   * The page passes a token it minted and the *vendor's name*, never a
   * command and never an address — the app decides both from the server it is
   * signed in to. That is the same rule `install` follows, and it is what
   * keeps a remote document from writing an arbitrary config, or aiming
   * somebody's editor and its credential somewhere else.
   */
  connectEditor: async (vendor, token) =>
    await ipcRenderer.invoke("kumi:connect-editor", vendor, token),
  /** Which editors this build knows how to write a config for. */
  connectable: CONNECTABLE,
  // One listener per call site, removed by the returned function, so a page
  // that opens the dialog repeatedly does not accumulate them.
  onOutput: (listener) => {
    const relay = (_event, line) => listener(String(line));
    ipcRenderer.on("kumi:install-output", relay);
    return () => ipcRenderer.removeListener("kumi:install-output", relay);
  },
}));
