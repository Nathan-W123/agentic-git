/**
 * Telling the desktop app that this worker is mid-task.
 *
 * ### Why the host needs to know
 *
 * The app holds the machine awake while a task runs, and only while a task
 * runs. Holding it open for as long as the worker is *enabled* would keep
 * somebody's laptop from ever sleeping, which is not a reasonable thing to do
 * to a person who volunteered their hardware; holding it for nothing at all
 * lets the machine sleep halfway through an agent's execution, which loses the
 * work and strands the lease until it expires. So the window has to be the
 * lease's own lifetime, and only this process knows where that starts and ends.
 *
 * ### Why it is a no-op almost everywhere
 *
 * `process.parentPort` exists only inside an Electron `utilityProcess`. Run
 * the worker the way `docs/deployment/desktop-worker.md` describes — a bare
 * `node apps/worker/dist/index.js` — and there is no port, no host listening,
 * and nothing to say. Every call here is then a feature-detect that falls
 * through, which is what keeps a message for the desktop app from becoming a
 * requirement of running a worker at all.
 */

/** The message shapes the desktop app's supervisor understands. */
export type HostSignal = { readonly type: "busy" | "idle" };

interface ParentPort {
  postMessage: (message: unknown) => void;
}

function port(): ParentPort | undefined {
  const candidate = (process as { parentPort?: unknown }).parentPort;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as ParentPort).postMessage === "function"
  ) {
    return candidate as ParentPort;
  }
  return undefined;
}

/**
 * Best-effort by construction.
 *
 * A host that cannot be told is a host that lets the machine sleep, which is
 * exactly where this started; it is never a reason to fail a task, so the
 * throw is swallowed rather than surfaced.
 */
export function signalHost(type: HostSignal["type"]): void {
  try {
    port()?.postMessage({ type } satisfies HostSignal);
  } catch {
    // See above.
  }
}

/** How many tasks are holding the machine awake right now. */
let holders = 0;

/**
 * Holds the machine awake for one task, and lets it sleep when the last one
 * ends.
 *
 * A worker runs several tasks at once, and "busy" is a statement about the
 * machine rather than about a task. Sent as a bare pair of signals, the first
 * run to finish says "idle" while three agents are still working, and the
 * laptop sleeps on top of them — losing exactly the work the signal exists to
 * protect. So the signals are edges on a count: `busy` when the count leaves
 * zero, `idle` when it returns.
 *
 * The returned release is idempotent, because the run that took the hold
 * releases it from a `finally` that a cancellation can reach twice.
 */
export function holdHost(): () => void {
  holders += 1;
  if (holders === 1) {
    signalHost("busy");
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holders -= 1;
    if (holders === 0) {
      signalHost("idle");
    }
  };
}

/** For tests: how many holds are outstanding. */
export function hostHoldCount(): number {
  return holders;
}
