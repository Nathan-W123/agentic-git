import assert from "node:assert/strict";
import test from "node:test";

import { holdHost, hostAttached, hostHoldCount, signalHost } from "./host-signal.js";

/**
 * Captures what the host would have been told, by standing in for the port an
 * Electron `utilityProcess` supplies. Restored on the way out, because the
 * absence of a port is what makes every other test's signal a no-op.
 */
function recordSignals(): {
  sent: string[];
  messages: unknown[];
  restore: () => void;
} {
  const host = process as { parentPort?: unknown };
  const previous = host.parentPort;
  const sent: string[] = [];
  const messages: unknown[] = [];
  host.parentPort = {
    postMessage(message: unknown) {
      sent.push((message as { type: string }).type);
      messages.push(message);
    },
  };
  return {
    sent,
    messages,
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

/**
 * What was withheld reaches the host whole, and touches nothing else.
 *
 * The allowlist that withheld a server is read once at worker start and
 * belongs to the machine's owner, so the only way it ever changes is for the
 * desktop app to ask them — and the app can only ask about servers it has
 * been told the names of. A signal that arrived as a bare type would tell the
 * host that *something* was withheld and leave it nothing to ask about.
 *
 * It is not a hold: a run that has already declined its tools is no more or
 * less deserving of a machine kept awake, and a count moved by this signal
 * would let the laptop sleep on a task still running, or never sleep at all.
 */
test("the host is told which MCP servers were withheld, and what each one is", (t) => {
  // Nothing listening: the worker phrases what it withheld for a person
  // with a config file, not for an app that will ask.
  assert.equal(hostAttached(), false);
  const recorder = recordSignals();
  t.after(recorder.restore);
  assert.equal(hostAttached(), true);
  assert.equal(hostHoldCount(), 0);

  const servers = [
    { name: "github", digest: "0123", summary: "github: talks to https://mcp.example/github" },
    { name: "linear", digest: "4567", summary: "linear: runs npx -y @linear/mcp" },
  ];
  signalHost({ type: "mcp-offered", servers });
  assert.deepEqual(recorder.messages, [{ type: "mcp-offered", servers }]);
  assert.equal(hostHoldCount(), 0);

  // The older spelling still works, and lands as the same object shape the
  // host has always read.
  signalHost("busy");
  signalHost({ type: "idle" });
  assert.deepEqual(recorder.sent, ["mcp-offered", "busy", "idle"]);
  assert.deepEqual(recorder.messages[1], { type: "busy" });
  assert.deepEqual(recorder.messages[2], { type: "idle" });
  assert.equal(hostHoldCount(), 0);
});
