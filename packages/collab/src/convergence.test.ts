import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CollaborativeClient } from "./client.js";
import { CollabDocument } from "./document.js";
import { randomOperation, randomText, seededRandom } from "./random.js";
import { applyOperation, type TextOperation } from "./text-operation.js";

/**
 * End-to-end simulation of the real loop: several browsers editing one
 * server-held document over links that deliver in order but at arbitrary
 * times.
 *
 * This is the test that matters. The primitives can each be correct while the
 * client state machine still drops a rebase, and the failure mode is a
 * document that silently diverges between two people's screens.
 */

type Inbound =
  | { readonly kind: "ack" }
  | { readonly kind: "op"; readonly operation: TextOperation };

interface Outbound {
  readonly revision: number;
  readonly operation: TextOperation;
}

class SimulatedClient {
  public text: string;
  public readonly client: CollaborativeClient;
  public readonly toServer: Outbound[] = [];
  public readonly fromServer: Inbound[] = [];

  public constructor(content: string, revision: number) {
    this.text = content;
    this.client = new CollaborativeClient(revision);
  }

  public edit(operation: TextOperation): void {
    this.text = applyOperation(this.text, operation);
    const action = this.client.applyLocal(operation);
    if (action.send !== undefined) {
      this.toServer.push(action.send);
    }
  }

  /** Delivers one message from the server. Returns false when idle. */
  public receive(): boolean {
    const message = this.fromServer.shift();
    if (message === undefined) {
      return false;
    }
    const action =
      message.kind === "ack"
        ? this.client.acknowledge()
        : this.client.applyServer(message.operation);
    if (action.apply !== undefined) {
      this.text = applyOperation(this.text, action.apply);
    }
    if (action.send !== undefined) {
      this.toServer.push(action.send);
    }
    return true;
  }
}

class Simulation {
  public readonly document: CollabDocument;
  public readonly clients: SimulatedClient[];

  public constructor(content: string, clientCount: number) {
    this.document = new CollabDocument(content);
    this.clients = Array.from(
      { length: clientCount },
      () => new SimulatedClient(content, 0),
    );
  }

  /** Delivers one queued operation from `index` to the server. */
  public deliverToServer(index: number): boolean {
    const sender = this.clients[index];
    const message = sender?.toServer.shift();
    if (sender === undefined || message === undefined) {
      return false;
    }
    const applied = this.document.receive(message.revision, message.operation);
    for (const [other, client] of this.clients.entries()) {
      client.fromServer.push(
        other === index ? { kind: "ack" } : { kind: "op", operation: applied.operation },
      );
    }
    return true;
  }

  /** Runs every queue to exhaustion, which is what quiescence looks like. */
  public settle(): void {
    for (let guard = 0; guard < 10_000; guard += 1) {
      let progressed = false;
      for (const index of this.clients.keys()) {
        while (this.deliverToServer(index)) {
          progressed = true;
        }
      }
      for (const client of this.clients) {
        while (client.receive()) {
          progressed = true;
        }
      }
      if (!progressed) {
        return;
      }
    }
    assert.fail("the simulation never quiesced");
  }

  public assertConverged(message: string): void {
    for (const [index, client] of this.clients.entries()) {
      assert.ok(
        client.client.synchronized,
        `${message}: client ${index} still has work in flight`,
      );
      assert.equal(
        client.text,
        this.document.content,
        `${message}: client ${index} diverged from the server`,
      );
      assert.equal(
        client.client.revision,
        this.document.revision,
        `${message}: client ${index} is at the wrong revision`,
      );
    }
  }
}

describe("client and server convergence", () => {
  it("delivers a single edit to the other client", () => {
    const simulation = new Simulation("hello", 2);
    const [first, second] = simulation.clients;
    assert.ok(first !== undefined && second !== undefined);
    first.edit({ components: [5, " world"], baseLength: 5, targetLength: 11 });
    simulation.settle();
    assert.equal(second.text, "hello world");
    simulation.assertConverged("single edit");
  });

  it("converges when two clients type at the same offset", () => {
    const simulation = new Simulation("ac", 2);
    const [first, second] = simulation.clients;
    assert.ok(first !== undefined && second !== undefined);
    // Both edits are composed against revision 0; neither has seen the other.
    first.edit({ components: [1, "X", 1], baseLength: 2, targetLength: 3 });
    second.edit({ components: [1, "Y", 1], baseLength: 2, targetLength: 3 });
    simulation.settle();
    assert.equal(simulation.document.content.length, 4);
    simulation.assertConverged("simultaneous insert");
  });

  it("converges when a client keeps typing while an edit is unacknowledged", () => {
    const simulation = new Simulation("abc", 2);
    const [first, second] = simulation.clients;
    assert.ok(first !== undefined && second !== undefined);
    first.edit({ components: [3, "1"], baseLength: 3, targetLength: 4 });
    first.edit({ components: [4, "2"], baseLength: 4, targetLength: 5 });
    first.edit({ components: [5, "3"], baseLength: 5, targetLength: 6 });
    // Only the first operation went out; the rest are buffered behind it.
    assert.equal(first.toServer.length, 1);
    second.edit({ components: ["Z", 3], baseLength: 3, targetLength: 4 });
    simulation.settle();
    assert.equal(simulation.document.content, "Zabc123");
    simulation.assertConverged("buffered edits");
  });

  it("converges under randomized interleavings", () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const random = seededRandom(seed * 31);
      const clientCount = 2 + Math.floor(random() * 3);
      const simulation = new Simulation(
        randomText(random, Math.floor(random() * 25)),
        clientCount,
      );
      for (let step = 0; step < 60; step += 1) {
        const index = Math.floor(random() * clientCount);
        const client = simulation.clients[index];
        if (client === undefined) {
          continue;
        }
        const choice = random();
        if (choice < 0.45) {
          client.edit(randomOperation(random, client.text));
        } else if (choice < 0.75) {
          simulation.deliverToServer(index);
        } else {
          client.receive();
        }
      }
      simulation.settle();
      simulation.assertConverged(`seed ${seed}`);
    }
  });

  it("converges when one client only ever reads", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = seededRandom(seed * 97);
      const simulation = new Simulation(randomText(random, 20), 3);
      const [writer, secondWriter, reader] = simulation.clients;
      assert.ok(
        writer !== undefined && secondWriter !== undefined && reader !== undefined,
      );
      for (let step = 0; step < 40; step += 1) {
        const author = random() < 0.5 ? writer : secondWriter;
        if (random() < 0.5) {
          author.edit(randomOperation(random, author.text));
        } else {
          simulation.deliverToServer(simulation.clients.indexOf(author));
          reader.receive();
        }
      }
      simulation.settle();
      simulation.assertConverged(`reader seed ${seed}`);
      assert.ok(reader.client.synchronized);
    }
  });
});
