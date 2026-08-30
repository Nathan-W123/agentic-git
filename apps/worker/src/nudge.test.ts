import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkNudge,
  type WebSocketLike,
  type WorkNudgeOptions,
} from "./nudge.js";

/** A socket the test drives by hand. */
function fakeSocket(): WebSocketLike & { deliver: () => void; drop: () => void } {
  const socket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: () => undefined,
    deliver: () => socket.onmessage?.call(socket, { data: "{}" }),
    drop: () => socket.onclose?.call(socket, {}),
  } as WebSocketLike & { deliver: () => void; drop: () => void };
  return socket;
}

const ticketing = (async () =>
  new Response(JSON.stringify({ ticket: "t_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

function make(overrides: Partial<WorkNudgeOptions> = {}) {
  const socket = fakeSocket();
  const nudge = new WorkNudge({
    serverUrl: "https://control.invalid",
    token: "tok",
    organizationId: "org_1",
    fetchImpl: ticketing,
    socketFactory: () => socket,
    ...overrides,
  });
  return { nudge, socket };
}

/** Resolves to true if the promise settled inside `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number) {
  return await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), ms);
    }),
  ]);
}

test("a nudge cuts the wait short", async () => {
  const { nudge, socket } = make();
  nudge.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A full minute of backoff, ended by one frame.
  const waiting = nudge.wait(60_000);
  socket.deliver();
  assert.equal(await settledWithin(waiting, 500), true);
  nudge.stop();
});

test("with no nudge it waits the interval it was given", async () => {
  const { nudge } = make();
  nudge.start();
  assert.equal(await settledWithin(nudge.wait(10_000), 100), false);
  nudge.stop();
});

test("a nudge that lands mid-iteration is not lost", async () => {
  // The worker is busy when the message arrives, so nobody is in `wait` to
  // hear it. Dropping it would leave the worker sleeping a full interval
  // having just been told there was work.
  const { nudge, socket } = make();
  nudge.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.deliver();
  assert.equal(await settledWithin(nudge.wait(60_000), 500), true);
  nudge.stop();
});

test("the latch clears, so one message does not skip every future wait", async () => {
  const { nudge, socket } = make();
  nudge.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.deliver();
  await nudge.wait(60_000);
  assert.equal(await settledWithin(nudge.wait(10_000), 100), false);
  nudge.stop();
});

test("a control plane that will not issue a ticket costs latency, not work", async () => {
  // The whole safety property: everything about this is optional, so a server
  // that refuses the ticket leaves a worker on its original poll cadence
  // rather than a worker that has stopped.
  const refusing = (async () =>
    new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const { nudge } = make({ fetchImpl: refusing });
  nudge.start();
  assert.equal(await settledWithin(nudge.wait(10_000), 100), false);
  nudge.stop();
});

test("stopping releases anyone parked in wait", async () => {
  const { nudge } = make();
  nudge.start();
  const waiting = nudge.wait(60_000);
  nudge.stop();
  assert.equal(await settledWithin(waiting, 500), true);
});
