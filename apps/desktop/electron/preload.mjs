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
 * back into this process.
 */

import { contextBridge } from "electron";

function argument(name) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ??
    ""
  );
}

contextBridge.exposeInMainWorld("KUMI_SERVER", argument("kumi-server"));
contextBridge.exposeInMainWorld("KUMI_TOKEN", argument("kumi-token"));
