import { createHash } from "node:crypto";

import type { AuditEvent } from "@coord/shared-types";

/**
 * Tamper-evident hashing for the audit log.
 *
 * Every event carries the hash of its own payload and a chain hash that folds
 * in the previous event. Removing, reordering, or editing any event breaks the
 * chain from that point forward, which {@link verifyAuditChain} detects and
 * locates. This is detection, not prevention: an attacker with write access to
 * the database file can recompute the whole chain. It raises the cost of a
 * silent edit and makes an inconsistent history obvious during review.
 */

export const GENESIS_HASH = "0".repeat(64);

/**
 * Serializes with sorted keys so a payload always hashes to the same digest
 * regardless of the order the fields happened to be written in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashAuditPayload(event: AuditEvent): string {
  return sha256(
    canonicalJson({
      id: event.id,
      type: event.type,
      taskId: event.taskId ?? null,
      occurredAt: event.occurredAt,
      data: event.data,
    }),
  );
}

export function chainHash(previousHash: string, payloadHash: string): string {
  return sha256(`${previousHash}:${payloadHash}`);
}

export interface ChainedAuditEvent {
  event: AuditEvent;
  sequence: number;
  payloadHash: string;
  previousHash: string;
  chainHash: string;
}

export type AuditChainVerification =
  | { valid: true; events: number }
  | {
      valid: false;
      events: number;
      /** Sequence number of the first event that does not match its hashes. */
      brokenAt: number;
      reason: string;
    };

export function verifyAuditChain(
  entries: readonly ChainedAuditEvent[],
): AuditChainVerification {
  let previousHash = GENESIS_HASH;

  for (const entry of entries) {
    if (entry.previousHash !== previousHash) {
      return {
        valid: false,
        events: entries.length,
        brokenAt: entry.sequence,
        reason:
          "The recorded previous hash does not match the preceding event; " +
          "an event was removed, reordered, or inserted",
      };
    }

    const payloadHash = hashAuditPayload(entry.event);
    if (payloadHash !== entry.payloadHash) {
      return {
        valid: false,
        events: entries.length,
        brokenAt: entry.sequence,
        reason: "The event contents no longer match the recorded payload hash",
      };
    }

    const expectedChain = chainHash(entry.previousHash, payloadHash);
    if (expectedChain !== entry.chainHash) {
      return {
        valid: false,
        events: entries.length,
        brokenAt: entry.sequence,
        reason: "The recorded chain hash is not derived from this event",
      };
    }

    previousHash = entry.chainHash;
  }

  return { valid: true, events: entries.length };
}
