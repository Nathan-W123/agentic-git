import assert from "node:assert/strict";
import test from "node:test";

import type { AuditEvent } from "@coord/shared-types";

import {
  GENESIS_HASH,
  canonicalJson,
  chainHash,
  hashAuditPayload,
  verifyAuditChain,
  type ChainedAuditEvent,
} from "./audit-chain.js";

function event(id: string, data: Record<string, unknown> = {}): AuditEvent {
  return {
    id,
    type: "task_submitted",
    occurredAt: "2026-01-01T00:00:00.000Z",
    data,
    taskId: "task_1",
  };
}

function chain(events: readonly AuditEvent[]): ChainedAuditEvent[] {
  let previousHash = GENESIS_HASH;
  return events.map((entry, index) => {
    const payloadHash = hashAuditPayload(entry);
    const linked: ChainedAuditEvent = {
      event: entry,
      sequence: index + 1,
      payloadHash,
      previousHash,
      chainHash: chainHash(previousHash, payloadHash),
    };
    previousHash = linked.chainHash;
    return linked;
  });
}

test("canonical JSON is independent of key order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("canonical JSON preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("undefined members are omitted rather than serialized", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("an intact chain verifies", () => {
  const result = verifyAuditChain(chain([event("a"), event("b"), event("c")]));
  assert.deepEqual(result, { valid: true, events: 3 });
});

test("an empty chain verifies", () => {
  assert.deepEqual(verifyAuditChain([]), { valid: true, events: 0 });
});

test("editing an event's contents is detected", () => {
  const entries = chain([event("a"), event("b", { before: 1 }), event("c")]);
  const tampered = entries[1];
  if (tampered === undefined) {
    throw new Error("expected a second entry");
  }
  tampered.event = event("b", { after: 2 });

  const result = verifyAuditChain(entries);
  assert.equal(result.valid, false);
  if (result.valid) {
    return;
  }
  assert.equal(result.brokenAt, 2);
  assert.match(result.reason, /no longer match the recorded payload hash/u);
});

test("removing an event from the middle is detected", () => {
  const entries = chain([event("a"), event("b"), event("c")]);
  const result = verifyAuditChain([entries[0]!, entries[2]!]);
  assert.equal(result.valid, false);
  if (result.valid) {
    return;
  }
  assert.equal(result.brokenAt, 3);
  assert.match(result.reason, /removed, reordered, or inserted/u);
});

test("reordering events is detected", () => {
  const entries = chain([event("a"), event("b"), event("c")]);
  const result = verifyAuditChain([entries[1]!, entries[0]!, entries[2]!]);
  assert.equal(result.valid, false);
});

test("a recomputed payload hash without a chain update is detected", () => {
  const entries = chain([event("a"), event("b")]);
  const tampered = entries[1];
  if (tampered === undefined) {
    throw new Error("expected a second entry");
  }
  // Simulates an attacker who updates the event and its payload hash but not
  // the chain hash that binds it to the previous event.
  tampered.event = event("b", { injected: true });
  tampered.payloadHash = hashAuditPayload(tampered.event);

  const result = verifyAuditChain(entries);
  assert.equal(result.valid, false);
  if (result.valid) {
    return;
  }
  assert.match(result.reason, /not derived from this event/u);
});
