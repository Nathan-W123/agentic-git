/**
 * Kumi's own dialogs, instead of the operating system's.
 *
 * Everything this app said during setup was said by `dialog.showMessageBox` —
 * a white Win32 message box with a red circle in it, four flat buttons and a
 * title bar reading "Error". It is the right control for "your disk is full".
 * It is the wrong one for the first five minutes of a product: a person who
 * has just installed Kumi is looking at something that does not resemble Kumi,
 * cannot tell whether it came from the app or from Windows, and is being asked
 * to choose a vendor in a widget that looks like a fault report.
 *
 * So the dialogs are the app's. The palette is the dashboard's own eight
 * tokens, held here rather than fetched because this window opens before any
 * server is known — and sometimes *because* one could not be reached.
 *
 * ### Why one window rather than one per message
 *
 * An offer, the run it starts and the result it ends in are one conversation.
 * The native version was three modals in a row, each dismissed before the next
 * appeared, and the middle one did not exist at all — the install ran with no
 * window watching it, which is why a failure could only ever be reported as
 * its exit code. {@link openDialog} hands back a handle whose contents can be
 * replaced in place, so the offer becomes the progress becomes the answer.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, ipcMain } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Distinguishes one dialog's channels from another's. */
let sequence = 0;

/**
 * Opens a dialog and hands back the means to drive it.
 *
 * `chosen` resolves with the index of the button pressed, or with the spec's
 * `cancelId` if the window was closed — by the ✕, by Escape, or by the person
 * closing it from the taskbar. It resolves exactly once and never rejects: a
 * dialog that throws when somebody closes it is a dialog every caller has to
 * wrap.
 */
export function openDialog(spec) {
  const id = String(++sequence);
  const channel = (name) => `kumi:dialog:${id}:${name}`;
  let content = { ...spec };

  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const window = new BrowserWindow({
    width: 480,
    height: 260,
    ...(parent === undefined ? {} : { parent, modal: true }),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    // Painted before the page is, so opening a dialog is not a white flash on
    // the way to a dark one.
    backgroundColor: "#121110",
    title: spec.title ?? "Kumi",
    webPreferences: {
      preload: path.join(here, "dialog-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--kumi-dialog-id=${id}`],
    },
  });

  let settle;
  const chosen = new Promise((resolve) => {
    settle = resolve;
  });
  let answered = false;
  const answer = (index) => {
    if (!answered) {
      answered = true;
      settle(index);
    }
  };

  // Synchronous, because the page asks before its first paint — see the
  // preload for why it cannot be a message.
  ipcMain.on(channel("content"), (event) => {
    event.returnValue = content;
  });
  ipcMain.on(channel("choose"), (_event, index) => {
    answer(typeof index === "number" ? index : -1);
  });
  ipcMain.on(channel("measured"), (_event, height) => {
    if (window.isDestroyed() || typeof height !== "number") {
      return;
    }
    // Bounded at both ends: a dialog shorter than this looks like a fragment,
    // and one taller than this is a window, not a dialog. The page's own log
    // pane scrolls inside whatever it is given.
    const wanted = Math.max(150, Math.min(560, Math.ceil(height)));
    const [width] = window.getContentSize();
    // A window declared unresizable refuses `setContentSize` on some Linux
    // window managers — silently, so the dialog keeps whatever height it was
    // created with and either clips its last line or trails a band of empty
    // panel. Lifting the constraint for the one call is the portable way to
    // fit a window to its contents; it is put straight back, so the dialog is
    // still not something a person can drag out of shape.
    window.setResizable(true);
    window.setContentSize(width, wanted, false);
    window.setResizable(false);
    window.center();
  });

  // Closing without pressing anything is an answer too, and it is the spec's
  // own `cancelId` rather than a convention this module invents.
  window.once("closed", () => {
    answer(typeof spec.cancelId === "number" ? spec.cancelId : -1);
    for (const name of ["content", "choose", "measured"]) {
      ipcMain.removeAllListeners(channel(name));
    }
  });

  // Shown on `ready-to-show` rather than when the page reports its height.
  // Waiting for the measurement deadlocks: Chromium does not run
  // `requestAnimationFrame` in a window that is not visible, so a dialog that
  // only appears once it has measured itself is a dialog that never measures
  // and never appears. It comes up at its declared size and settles onto its
  // real one a frame later.
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.center();
      window.show();
    }
  });

  void window.loadFile(path.join(here, "dialog.html"));

  const send = (name, value) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel(name), value);
    }
  };

  return {
    chosen,
    /** Replaces what the window is showing, keeping the window itself. */
    update(next) {
      content = { ...content, ...next };
      // `log` applies only to the update that names it. Merged like the rest,
      // the empty string that clears the pane when a run starts would be
      // inherited by the state that reports how the run went — and on a
      // failure the output is the whole of what the reader needs, so clearing
      // it there threw away the answer at the moment of asking the question.
      if (!Object.hasOwn(next, "log")) {
        delete content.log;
      }
      answered = false;
      send("set", content);
    },
    /** Appends a line of whatever this dialog is watching. */
    log(text) {
      send("log", String(text));
    },
    close() {
      if (!window.isDestroyed()) {
        window.close();
      }
    },
  };
}

/**
 * The common case: ask, wait, close.
 *
 * Resolves with the index of the button pressed, or `cancelId` if the window
 * was closed instead — which is why every caller passes one rather than
 * checking for a sentinel this module chose.
 */
export async function askDialog(spec) {
  const dialog = openDialog(spec);
  const index = await dialog.chosen;
  dialog.close();
  return index;
}

/**
 * Says one thing and waits to be dismissed.
 *
 * The button is named by the caller because "OK" is not always the word: an
 * error a person can act on ends in the action, and one they cannot ends in
 * acknowledgement.
 */
export async function tellDialog(spec) {
  await askDialog({ buttons: ["OK"], cancelId: 0, ...spec });
}
