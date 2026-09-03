/**
 * What the control plane remembers about an editor between two of its calls.
 *
 * A desktop worker is a process that polls: it says it is alive every five
 * seconds, and the `workers` table is where that fact lives. An editor is not
 * that. Claude Code, Cursor and Codex speak to Kumi only when the person in
 * front of them says something, so the same table would record them as dead
 * three minutes into every session and mint a dead row per session besides,
 * which is the growth this deployment has just finished getting rid of.
 *
 * So the two things an editor needs remembering for live here instead, in
 * memory, deliberately:
 *
 * - **Presence**, declared by the editor rather than inferred from a
 *   heartbeat. It says "I am working" by taking work, and that holds for a
 *   window rather than until the next beat.
 * - **A bundle ticket**, issued when work is taken and spent seconds later on
 *   one download. Not a token, not stored, not reusable.
 *
 * Losing either to a restart is not a fault. Presence lapses, which is what
 * presence does; a ticket lapses, and `extend_task` issues another. Nothing
 * here is the record of anything. The lease is.
 */

import { randomUUID } from "node:crypto";

/**
 * How long an editor is taken to be at the keyboard after it takes work.
 *
 * Long, because the alternative is worse. An editor cannot be woken: nothing
 * polls on its behalf, so a window that lapses mid-task makes the agent read
 * as offline while it is demonstrably running something. Half an hour is the
 * lease, and presence outliving the lease slightly is the harmless direction
 * to be wrong in. The worst it costs is one mention dispatched to somebody
 * who has closed their laptop, which is exactly what the stall sweep is for.
 */
export const EDITOR_PRESENCE_MS = 30 * 60 * 1000;

/** How long a bundle ticket is good for. Issued, then spent within seconds. */
export const BUNDLE_TICKET_MS = 10 * 60 * 1000;

/** A ticket that has not been spent yet. */
interface BundleTicket {
  readonly leaseId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

/**
 * Which people have an editor listening, and for which vendor.
 *
 * The shape is the one the gateway's own liveness answer already uses, owner
 * to the set of vendors they can drive, so this can be merged into that
 * answer rather than consulted beside it. A second liveness question asked in
 * a second place is how an agent comes to read as online on the roster and
 * offline at dispatch.
 */
export class EditorPresence {
  private readonly entries = new Map<string, number>();

  /** Records that this person's editor is driving this vendor right now. */
  declare(input: {
    userId: string;
    vendor: string;
    now?: number;
    ttlMs?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.prune(now);
    this.entries.set(
      EditorPresence.key(input.userId, input.vendor),
      now + (input.ttlMs ?? EDITOR_PRESENCE_MS),
    );
  }

  /** Everyone with an editor listening, by owner, as of `now`. */
  owners(now: number = Date.now()): Map<string, Set<string>> {
    this.prune(now);
    const live = new Map<string, Set<string>>();
    for (const key of this.entries.keys()) {
      const [userId, vendor] = key.split(" ");
      if (userId === undefined || vendor === undefined) {
        continue;
      }
      const vendors = live.get(userId) ?? new Set<string>();
      vendors.add(vendor);
      live.set(userId, vendors);
    }
    return live;
  }

  /** Forgets this person's editor for one vendor. */
  withdraw(userId: string, vendor: string): void {
    this.entries.delete(EditorPresence.key(userId, vendor));
  }

  /**
   * Dropped on every write and every read rather than on a timer.
   *
   * A timer would be a handle held open for the life of the process to tidy a
   * map that only grows when somebody is using it. Both entry points here run
   * often enough that the map cannot outgrow the people actually working.
   */
  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * A space, because neither half can contain one: a user id is generated and
   * a vendor comes from a fixed list. Splitting on it below is therefore
   * exact rather than a guess about which separator is safe.
   */
  private static key(userId: string, vendor: string): string {
    return `${userId} ${vendor}`;
  }
}

/**
 * One-shot permission to download one lease's bundle.
 *
 * The bundle route a desktop worker uses asks for `run_task`, and that is the
 * same scope `POST /workers/leases` asks for, so handing an editor's token
 * that permission would let a token given out for "do this one task" register
 * as a worker and take other people's. The editor gets a ticket instead: it
 * names one lease, belongs to one person, is spent on first use, and expires
 * on its own.
 */
export class BundleTickets {
  private readonly tickets = new Map<string, BundleTicket>();

  issue(input: { leaseId: string; userId: string; now?: number }): string {
    const now = input.now ?? Date.now();
    this.prune(now);
    const id = randomUUID();
    this.tickets.set(id, {
      leaseId: input.leaseId,
      userId: input.userId,
      expiresAt: now + BUNDLE_TICKET_MS,
    });
    return id;
  }

  /** Spends a ticket. A second attempt with the same id gets nothing. */
  redeem(
    id: string,
    now: number = Date.now(),
  ): { leaseId: string; userId: string } | undefined {
    this.prune(now);
    const ticket = this.tickets.get(id);
    if (ticket === undefined) {
      return undefined;
    }
    this.tickets.delete(id);
    return { leaseId: ticket.leaseId, userId: ticket.userId };
  }

  private prune(now: number): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(id);
      }
    }
  }
}
