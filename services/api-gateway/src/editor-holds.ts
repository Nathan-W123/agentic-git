/**
 * Who is in a file right now — people and agents in one list.
 *
 * The two have always been recorded in different places for good reasons. An
 * agent's hold is a side effect of an admitted plan and lives on its lease; a
 * person's is a row taken on their first keystroke and renewed while the tab
 * is open. Neither is going to become the other.
 *
 * But a reader never wants one of them. "Can I edit this" and "who else is in
 * here" are the same question about both kinds of holder, and asking it twice
 * in two shapes is how a save comes to be refused for a reason the editor
 * cannot draw. So they are merged here, once, and everything downstream — the
 * gate on save, the blocks in the margin — reads the merged answer.
 *
 * Deliberately free of the store and the request: what makes this worth
 * testing is the merge and the overlap arithmetic, and neither needs a
 * database to be got wrong.
 */

import type { ClaimedRange, EditorHold } from "@coord/persistence";
import type { ResourceLease } from "@coord/shared-types";

/** One holder of one file, whichever kind of thing is holding it. */
export interface FileHolder {
  kind: "human" | "agent";
  /** A user id for a person, an agent id for an agent. */
  principalId: string;
  /** Present for an agent: what it is holding the file in order to do. */
  taskId?: string;
  file: string;
  /**
   * The lines held, empty for the whole file.
   *
   * Empty is the honest answer in two different situations — a plan that
   * named the file outright, and a person whose editor has not said where
   * they are — and both mean the same thing to a reader: assume all of it.
   */
  ranges: ClaimedRange[];
  /** When this holder took it, so a reader can see what is stale. */
  since: string;
  /** Present for a person: when it lapses without a renewal. */
  expiresAt?: string;
}

/** An agent's holdings, as they sit on an admitted plan. */
export interface AgentHolding {
  principalId: string;
  taskId: string;
  grants: readonly ResourceLease[];
}

function rangesOf(grant: ResourceLease): ClaimedRange[] {
  return (grant.ranges ?? []).map((range) => ({
    file: grant.resourceId,
    start: range.startLine,
    // Half-open, matching `ClaimedRange` everywhere else: a lease's
    // `endLine` is the last line it covers, and a range that ended there
    // would read as one line short against every other range in the system.
    end: range.endLine + 1,
  }));
}

/**
 * Everyone holding a file, or everyone holding anything when no path is given.
 *
 * `exceptUser` leaves the asker out. An editor wants "who *else* is in here",
 * and a person's own hold coming back as contention would make the gate below
 * refuse them their own file the moment they typed in it.
 */
export function holdersOfFile(input: {
  humans: readonly EditorHold[];
  agents: readonly AgentHolding[];
  path?: string;
  exceptUser?: string;
}): FileHolder[] {
  const wanted = input.path;
  const holders: FileHolder[] = [];
  for (const hold of input.humans) {
    if (hold.userId === input.exceptUser) {
      continue;
    }
    if (wanted !== undefined && hold.file !== wanted) {
      continue;
    }
    holders.push({
      kind: "human",
      principalId: hold.userId,
      file: hold.file,
      ranges: hold.ranges.map((range) => ({ ...range })),
      since: hold.acquiredAt,
      expiresAt: hold.expiresAt,
    });
  }
  for (const agent of input.agents) {
    for (const grant of agent.grants) {
      // Files only. A plan holds symbols, routes and schemas too, and none of
      // them is a thing to draw a block around in a text editor — they are
      // arbitrated where plans are arbitrated.
      if (grant.resourceType !== "file") {
        continue;
      }
      if (wanted !== undefined && grant.resourceId !== wanted) {
        continue;
      }
      holders.push({
        kind: "agent",
        principalId: agent.principalId,
        taskId: agent.taskId,
        file: grant.resourceId,
        ranges: rangesOf(grant),
        since: "",
      });
    }
  }
  return holders.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.kind.localeCompare(right.kind) ||
      left.principalId.localeCompare(right.principalId),
  );
}

/**
 * Whether a holder stands between somebody and the lines they are saving.
 *
 * Whole-file holds contend with everything, which is what an empty range list
 * means. Two range lists contend when any pair of them overlaps — half-open,
 * so a hold ending where another begins is two people on neighbouring lines
 * rather than a collision.
 */
export function holderBlocks(
  holder: FileHolder,
  ranges: readonly ClaimedRange[],
): boolean {
  if (holder.ranges.length === 0 || ranges.length === 0) {
    return true;
  }
  return holder.ranges.some((held) =>
    ranges.some((mine) => held.start < mine.end && mine.start < held.end),
  );
}
