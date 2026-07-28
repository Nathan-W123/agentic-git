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

/**
 * A signed-off boundary in the chain, written when events are archived.
 *
 * Compaction and tamper evidence pull in opposite directions: verification
 * walks from the genesis hash, so removing the front of the chain would leave
 * the remainder unverifiable. A checkpoint is what makes both possible — it
 * records the chain hash the live log continues from, plus a digest over the
 * segment that moved, so the archived range stays attested even if its rows
 * are later dropped to reclaim space.
 */
export interface AuditCheckpoint {
  id: string;
  /** Highest sequence this checkpoint covers. */
  throughSequence: number;
  /** Chain hash at `throughSequence`; the live chain verifies from here. */
  chainHash: string;
  /** Digest over the archived segment's payload hashes, in sequence order. */
  segmentDigest: string;
  events: number;
  createdAt: string;
}

/**
 * Folds a segment's payload hashes into one digest.
 *
 * Order-sensitive by construction: reordering the segment changes the digest,
 * so an archive cannot be silently rearranged and still match its checkpoint.
 */
export function segmentDigest(payloadHashes: readonly string[]): string {
  return sha256(`segment:${payloadHashes.join(":")}`);
}

export type AuditChainVerification =
  | {
      valid: true;
      events: number;
      /** Archived events re-verified against their checkpoints. */
      archivedEvents?: number;
      /** Checkpoints whose rows are no longer retained, only attested. */
      attestedCheckpoints?: number;
    }
  | {
      valid: false;
      events: number;
      /** Sequence number of the first event that does not match its hashes. */
      brokenAt: number;
      reason: string;
    };

/**
 * Verifies a run of events links correctly.
 *
 * `startHash` is the genesis hash for a full chain, or a checkpoint's chain
 * hash when the front of the log has been archived away.
 */
export function verifyAuditChain(
  entries: readonly ChainedAuditEvent[],
  startHash: string = GENESIS_HASH,
): AuditChainVerification {
  let previousHash = startHash;

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

export interface ArchivedSegment {
  checkpoint: AuditCheckpoint;
  /**
   * Retained archive rows for this checkpoint. Absent when the operator
   * dropped them to reclaim space; the checkpoint still attests the segment.
   */
  entries?: readonly ChainedAuditEvent[];
}

/**
 * Verifies a compacted log: archived segments first, then the live chain.
 *
 * A segment that is still retained is checked three ways — it must link
 * internally, it must end on exactly the chain hash its checkpoint recorded,
 * and its payload hashes must reproduce the checkpoint's segment digest. A
 * segment that is no longer retained contributes only its chain hash, which is
 * the honest limit of what a checkpoint alone can prove.
 */
export function verifyArchivedChain(
  segments: readonly ArchivedSegment[],
  live: readonly ChainedAuditEvent[],
): AuditChainVerification {
  const ordered = [...segments].sort(
    (left, right) =>
      left.checkpoint.throughSequence - right.checkpoint.throughSequence,
  );
  let previousHash = GENESIS_HASH;
  let archivedEvents = 0;
  let attestedCheckpoints = 0;

  for (const segment of ordered) {
    const { checkpoint, entries } = segment;
    if (entries === undefined || entries.length === 0) {
      attestedCheckpoints += 1;
      previousHash = checkpoint.chainHash;
      continue;
    }

    const linked = verifyAuditChain(entries, previousHash);
    if (!linked.valid) {
      return { ...linked, events: linked.events + live.length };
    }
    const last = entries.at(-1);
    if (last === undefined || last.chainHash !== checkpoint.chainHash) {
      return {
        valid: false,
        events: entries.length + live.length,
        brokenAt: checkpoint.throughSequence,
        reason:
          "The archived segment does not end on the chain hash its checkpoint recorded",
      };
    }
    if (
      segmentDigest(entries.map((entry) => entry.payloadHash)) !==
      checkpoint.segmentDigest
    ) {
      return {
        valid: false,
        events: entries.length + live.length,
        brokenAt: checkpoint.throughSequence,
        reason:
          "The archived segment no longer reproduces its checkpoint digest; " +
          "events were removed, reordered, or edited after archiving",
      };
    }

    archivedEvents += entries.length;
    previousHash = checkpoint.chainHash;
  }

  const result = verifyAuditChain(live, previousHash);
  if (!result.valid) {
    return result;
  }
  return {
    valid: true,
    events: result.events,
    ...(archivedEvents > 0 ? { archivedEvents } : {}),
    ...(attestedCheckpoints > 0 ? { attestedCheckpoints } : {}),
  };
}
