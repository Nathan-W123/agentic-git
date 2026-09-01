import {
  registerBlanketHolder,
  type HolderDeclaration,
} from "@coord/coordinator";
import type { TaskDefinition } from "@coord/shared-types";

/**
 * Reaching a repository-wide holder that is running on somebody's laptop.
 *
 * The narrowing that turns a blanket claim into an ordinary plan needs two
 * facts from the holder: what it has already written, and what the rest of its
 * work still needs. In-process both are a function call away — the coordinator
 * hands `observe` and `declare` straight to the plan authority. A holder on a
 * desktop is the same problem with a network in the middle, and this is the
 * seam that closes it.
 *
 * **Nothing new is invented for the asynchrony.** `freezeBlanketClaim` was
 * already written for an answer that has not come back yet: it raises
 * `BlanketAskPending` rather than freezing early, because a freeze is permanent
 * and an answer that arrives a second late would have nothing left to narrow.
 * An ask travelling to a laptop is an ask that has not answered yet, and the
 * arrival's behaviour — retry, join, do not freeze — is already specified. So a
 * remote holder registers through the same registry a local one does, and the
 * arrival never learns the difference.
 *
 * **Process-local, like the registry it plugs into.** What is kept here is a
 * promise waiting on an HTTP call this process is serving. A gateway that
 * restarts loses the ask; the claim stays blanket, which is the recoverable
 * state, and the next arrival asks again.
 */

/** A holder's last reading of its own workspace, and when it was taken. */
interface Reading {
  changes: readonly { path: string; status: "added" | "modified" | "deleted" }[];
  at: number;
}

/** An ask sent to a holder and not yet answered. */
interface Ask {
  id: string;
  settle(declaration: HolderDeclaration | undefined, reading?: Reading): void;
  /** Whether the heartbeat has already carried this ask down to the worker. */
  delivered: boolean;
}

const readings = new Map<string, Reading>();
const asks = new Map<string, Ask>();
const disposers = new Map<string, () => void>();

/**
 * How stale a reading may be and still be worth freezing on.
 *
 * A freeze hands the arrival everything the holder is *not* standing on, so a
 * reading older than the holder's last write is not a weaker observation, it is
 * a wrong one. While a claim is held the worker beats every ten seconds rather
 * than every sixty, and this is a little over one of those: a reading older
 * than this means the heartbeat carrying the next one has not landed, and the
 * arrival is told to come back rather than shown a stale answer.
 */
export const READING_FRESHNESS_MS = 25_000;

/** What the worker was told to beat at while it holds a claim. */
export const CLAIM_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * A holder's reported working set, read out of whatever it posted.
 *
 * Shared by the two routes that can carry one — the heartbeat and the
 * declaration — because they are the same fact arriving on different
 * deadlines, and a second copy of this parser is a second place for the two to
 * disagree about what counts. Anything unrecognised is dropped rather than
 * rejected: a worker a version ahead may report a status this one has never
 * heard of, and losing one entry is better than losing the observation.
 */
export function parseWorkingChanges(
  value: unknown,
): Reading["changes"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const changes: { path: string; status: "added" | "modified" | "deleted" }[] =
    [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const file = entry["path"];
    const status = entry["status"];
    if (typeof file !== "string" || file.length === 0) {
      continue;
    }
    if (status === "added" || status === "modified" || status === "deleted") {
      changes.push({ path: file, status });
    }
  }
  return changes;
}

/**
 * Records what a holder says it has written, off its heartbeat.
 *
 * Replaces rather than accumulates: the worker reports its whole working set
 * each time, so a file it has since reverted stops being held the moment it
 * stops being dirty.
 */
export function rememberWorkingChanges(
  taskId: string,
  changes: Reading["changes"],
): void {
  readings.set(taskId, { changes, at: Date.now() });
}

/** The freshest reading for this holder, if there is one worth using. */
export function freshWorkingChanges(
  taskId: string,
  now: number = Date.now(),
): Reading["changes"] | undefined {
  const reading = readings.get(taskId);
  if (reading === undefined || now - reading.at > READING_FRESHNESS_MS) {
    return undefined;
  }
  return reading.changes;
}

/**
 * The ask this holder should be told about on its next heartbeat, once.
 *
 * Marked delivered on the way out rather than on the answer, so a holder that
 * beats twice while it is thinking is not asked twice. The ask stays open —
 * `settleDeclaration` is what closes it — and the caller that started it is
 * still waiting on the same promise.
 */
export function askToDeliver(taskId: string): string | undefined {
  const ask = asks.get(taskId);
  if (ask === undefined || ask.delivered) {
    return undefined;
  }
  ask.delivered = true;
  return ask.id;
}

/**
 * The holder's answer, arriving on its own request rather than on the ask.
 *
 * The reading travels with it because it is the one taken at the moment the
 * agent was paused — the only observation of a remote holder that is exact
 * rather than up to a heartbeat old. A freeze computed from it is standing on
 * the same ground the in-process freeze stands on.
 *
 * An unknown or stale `askId` is ignored rather than treated as an error: the
 * ask it answers has been abandoned, the arrival has already retried, and
 * settling a promise nobody holds would be the only thing that could go wrong.
 */
export function settleDeclaration(
  taskId: string,
  askId: string,
  declaration: HolderDeclaration | undefined,
  changes?: Reading["changes"],
): boolean {
  const ask = asks.get(taskId);
  if (ask === undefined || ask.id !== askId) {
    return false;
  }
  if (changes !== undefined) {
    rememberWorkingChanges(taskId, changes);
  }
  asks.delete(taskId);
  ask.settle(declaration);
  return true;
}

/**
 * Publishes a way to reach a remote holder, for as long as it holds its claim.
 *
 * `declare` starts an ask and waits. It does not time out here — the caller
 * bounds it, and the bound is what turns a slow holder into `BlanketAskPending`
 * and a retry rather than into a premature freeze.
 */
export function registerRemoteHolder(input: {
  task: TaskDefinition;
  repositoryId: string;
  leaseId: string;
}): () => void {
  const taskId = input.task.id;
  const dispose = registerBlanketHolder({
    task: input.task,
    repositoryId: input.repositoryId,
    declare: async () =>
      await new Promise<HolderDeclaration | undefined>((resolve) => {
        const existing = asks.get(taskId);
        if (existing !== undefined) {
          // One ask per holder is the registry's own rule; this cannot
          // normally be reached, and joining rather than starting a second is
          // the safe reading of it.
          const previous = existing.settle;
          existing.settle = (declaration, reading) => {
            previous(declaration, reading);
            resolve(declaration);
          };
          return;
        }
        asks.set(taskId, {
          id: `ask_${input.leaseId}_${String(Date.now())}`,
          delivered: false,
          settle: (declaration) => resolve(declaration),
        });
      }),
  });
  const release = (): void => {
    dispose();
    readings.delete(taskId);
    // Anything still waiting is answered rather than left hanging: the holder
    // is gone, so the honest answer is that it has nothing to declare, and the
    // caller falls back to the freeze exactly as it does for any other failure.
    const ask = asks.get(taskId);
    if (ask !== undefined) {
      asks.delete(taskId);
      ask.settle(undefined);
    }
    disposers.delete(taskId);
  };
  disposers.get(taskId)?.();
  disposers.set(taskId, release);
  return release;
}

/**
 * Lets go of a remote holder when its lease ends, however it ends.
 *
 * Safe to call for a task that never held a claim, which is most of them —
 * that is what lets every settle path call it without first asking whether
 * there is anything to release.
 */
export function releaseRemoteHolder(taskId: string): void {
  disposers.get(taskId)?.();
}
