import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { WorkerEventHub } from "./worker-events.js";

/** A socket that records what was written to it instead of sending it. */
function socketDouble() {
  const socket = new PassThrough();
  const written: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => written.push(chunk));
  return {
    socket,
    text: () => Buffer.concat(written).toString("utf8"),
    bytes: () => Buffer.concat(written),
  };
}

function upgradeRequest(url: string): IncomingMessage {
  return {
    url,
    headers: {
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    },
  } as unknown as IncomingMessage;
}

const allow = async (_request: IncomingMessage, organizationId: string) => ({
  organizationId,
});

test("an upgrade for another hub's path is not claimed", async () => {
  // The load-bearing one. Node hands every upgrade to every listener, so a hub
  // that answered for paths it does not own would tear down the collaboration
  // or audit socket that the request was actually for.
  const hub = new WorkerEventHub({ authorize: allow });
  const { socket, text } = socketDouble();
  const claimed = await hub.tryUpgrade(
    upgradeRequest("/api/v1/collab?projectId=p"),
    socket,
    Buffer.alloc(0),
  );
  assert.equal(claimed, false);
  assert.equal(text(), "");
  assert.equal(socket.destroyed, false);
});

test("a worker with no organization named is refused, not connected", async () => {
  const hub = new WorkerEventHub({ authorize: allow });
  const { socket, text } = socketDouble();
  const claimed = await hub.tryUpgrade(
    upgradeRequest("/api/v1/workers/events"),
    socket,
    Buffer.alloc(0),
  );
  assert.equal(claimed, true);
  assert.match(text(), /400/u);
  assert.equal(hub.connections, 0);
});

test("a refused authorization closes the socket and holds no client", async () => {
  const hub = new WorkerEventHub({
    authorize: async () => {
      throw new Error("nope");
    },
  });
  const { socket, text } = socketDouble();
  await hub.tryUpgrade(
    upgradeRequest("/api/v1/workers/events?organizationId=org_1"),
    socket,
    Buffer.alloc(0),
  );
  assert.match(text(), /401/u);
  assert.equal(hub.connections, 0);
});

test("a nudge reaches its own organization and nobody else's", async () => {
  const hub = new WorkerEventHub({ authorize: allow });
  const mine = socketDouble();
  const theirs = socketDouble();
  await hub.tryUpgrade(
    upgradeRequest("/api/v1/workers/events?organizationId=org_1"),
    mine.socket,
    Buffer.alloc(0),
  );
  await hub.tryUpgrade(
    upgradeRequest("/api/v1/workers/events?organizationId=org_2"),
    theirs.socket,
    Buffer.alloc(0),
  );
  assert.equal(hub.connections, 2);

  const before = theirs.bytes().length;
  hub.notify("org_1");

  // The frame is a bare instruction to ask again, and carries no task.
  const delivered = mine.text();
  assert.match(delivered, /101 Switching Protocols/u);
  assert.match(delivered, /work_available/u);
  assert.doesNotMatch(delivered, /task/u);
  assert.equal(theirs.bytes().length, before);
});

test("closing the hub disconnects everyone", async () => {
  const hub = new WorkerEventHub({ authorize: allow });
  const { socket } = socketDouble();
  await hub.tryUpgrade(
    upgradeRequest("/api/v1/workers/events?organizationId=org_1"),
    socket,
    Buffer.alloc(0),
  );
  assert.equal(hub.connections, 1);
  hub.close();
  assert.equal(hub.connections, 0);
});
