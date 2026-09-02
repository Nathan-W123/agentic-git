import assert from "node:assert/strict";
import test from "node:test";

import { holdHost, hostHoldCount, signalHost } from "./host-signal.js";

/**
 * Captures what the host would have been told, by standing in for the port an
 * Electron `utilityProcess` supplies. Restored on the way out, because the
 * absence of a port is what makes every other test's signal a no-op.
 */
function recordSignals(): { sent: string[]; restore: () => void } {
  const host = process as { parentPort?: unknown };
  const previous = host.parentPort;
  const sent: string[] = [];
  host.parentPort = {
    postMessage(message: unknown) {
      sent.push((message as { type: string }).type);
    },
  };
  return {
    sent,
    restore: () => {
      if (previous === undefined) {
        delete host.parentPort;
      } else {
        host.parentPort = previous;
      }
    },
  };
}

/**
 * The machine is let go when the last task ends, not the first.
 *
 * "Busy" is a statement about the machine rather than about a task, and a
 * worker now runs several at once. Sent as a bare pair of signals, the first
 * run to finish tells the host it is idle while three agents are still
 * working, and the laptop sleeps on top of them — losing exactly the work the
 * signal exists to protect.
 */
test("the host is only told it is idle once the last task ends", (t) => {
  const recorder = recordSignals();
  t.after(recorder.restore);
  assert.equal(hostHoldCount(), 0);

  const first = holdHost();
  const second = holdHost();
  const third = holdHost();
  // One edge, not three: the host is being told the machine is in use, and it
  // already knows.
  assert.deepEqual(recorder.sent, ["busy"]);
  assert.equal(hostHoldCount(), 3);

  first();
  second();
  assert.deepEqual(recorder.sent, ["busy"], "released too early");

  third();
  assert.deepEqual(recorder.sent, ["busy", "idle"]);
  assert.equal(hostHoldCount(), 0);
});

test("releasing a hold twice does not let the machine sleep early", (t) => {
  const recorder = recordSignals();
  t.after(recorder.restore);

  const first = holdHost();
  const second = holdHost();
  // A run releases its hold from a `finally` that a cancellation can reach
  // twice; a second release that decremented the count would take the other
  // run's hold with it.
  first();
  first();
  assert.deepEqual(recorder.sent, ["busy"]);
  assert.equal(hostHoldCount(), 1);

  second();
  assert.deepEqual(recorder.sent, ["busy", "idle"]);
});

test("a signal with no host listening is a no-op rather than a failure", () => {
  const host = process as { parentPort?: unknown };
  const previous = host.parentPort;
  delete host.parentPort;
  try {
    assert.doesNotThrow(() => signalHost("busy"));
    const release = holdHost();
    assert.equal(hostHoldCount(), 1);
    release();
    assert.equal(hostHoldCount(), 0);
  } finally {
    if (previous !== undefined) {
      host.parentPort = previous;
    }
  }
});
