/**
 * The first-run window's one question, and the one answer it can give back.
 *
 * Separate from `preload.cjs` because it faces a different page for a
 * different reason. That one hands the dashboard two values it already has;
 * this one carries an address the person just typed into the main process, so
 * it can be checked against a live server before anything is written to disk.
 *
 * The check happens over IPC rather than in the page because the page is a
 * `file://` document: a request from it to somebody's deployment is a
 * cross-origin request, and would be refused for reasons that have nothing to
 * do with whether the address was right.
 *
 * CommonJS for the same reason as `preload.cjs`: a sandboxed renderer's
 * preload cannot be an ES module, and fails silently if it is.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kumiSetup", {
  /**
   * Resolves with `{ ok: true }` — after which this window is closed for you —
   * or `{ ok: false, message }` naming what went wrong in a sentence.
   */
  connect: async (address) => await ipcRenderer.invoke("kumi:connect", address),
});
