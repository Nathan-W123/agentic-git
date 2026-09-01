/**
 * The bridge for Kumi's own dialog window.
 *
 * Separate from the other two preloads for the same reason they are separate
 * from each other: it faces a different page with a different job. `preload.cjs`
 * hands the dashboard two values it already has, `setup-preload.cjs` carries an
 * address to be checked, and this one carries a dialog's contents out and a
 * person's answer back.
 *
 * The window's id travels in `additionalArguments` rather than in a message,
 * because the page asks for its contents synchronously before it has painted
 * anything — there is no earlier moment at which a message could have arrived,
 * and a dialog that flashes empty and then fills in is a dialog that looks
 * broken.
 *
 * CommonJS for the same reason as its siblings: a sandboxed renderer's preload
 * cannot be an ES module, and fails silently if it is.
 */

const { contextBridge, ipcRenderer } = require("electron");

const flag = "--kumi-dialog-id=";
const id =
  process.argv.find((argument) => argument.startsWith(flag))?.slice(flag.length) ??
  "";

const channel = (name) => `kumi:dialog:${id}:${name}`;

contextBridge.exposeInMainWorld("kumiDialog", {
  /** What to draw. Synchronous, so the first paint is already the real thing. */
  content: () => ipcRenderer.sendSync(channel("content")),
  /** The person pressed the button at this index. */
  choose: (index) => ipcRenderer.send(channel("choose"), index),
  /** Replaces the contents in place — an ask becomes a progress, then a result. */
  onContent: (handler) =>
    ipcRenderer.on(channel("set"), (_event, value) => handler(value)),
  /** A line of output from whatever this dialog is watching. */
  onLog: (handler) =>
    ipcRenderer.on(channel("log"), (_event, text) => handler(text)),
  /** How tall the window needs to be, once the page knows. */
  measured: (height) => ipcRenderer.send(channel("measured"), height),
});
