import type { TaskDefinition, TaskId } from "@coord/shared-types";

import type { HolderDeclaration } from "./blanket-claim.js";

/**
 * How a repository-wide holder is reached from the side that decides.
 *
 * The ask that turns a blanket claim into an ordinary plan needs two halves
 * that live in different places. The session and the adapter belong to the
 * coordinator run driving the holder; the decision about whether anybody has
 * arrived belongs to the plan authority, which reads the durable lease table
 * and has never heard of an adapter. Before this, only the coordinator's own
 * ten-second timer carried the ask — so an arrival, which decides in
 * milliseconds off the lease table, always narrowed the claim first and the
 * holder was never asked at all.
 *
 * This is the seam between them: a run publishes a way to ask its holder for
 * exactly as long as that holder is executing, and whoever narrows the claim
 * looks it up. The authority still never learns what an adapter is, and the
 * run still never learns who arrived.
 *
 * **Process-local, deliberately.** What is registered is a closure over a live
 * child process; there is no way to hand that to another process, and pretending
 * otherwise would be a lie in the one direction that matters. A holder running
 * elsewhere is simply not found here, and its claim is frozen exactly as it is
 * today — the arrival waits a retry instead of being let into files nobody
 * asked about. Two runs in one worker are the common case this exists for.
 */
export interface BlanketHolderSession {
  /** The holder itself, as the authority needs to name it on the lease. */
  task: TaskDefinition;
  /** Where it is working, so a lookup cannot cross repositories. */
  repositoryId: string;
  /**
   * Pauses the holder, asks it what the rest of its work needs, and resumes
   * it. Answers `undefined` for every failure — that is what makes the caller
   * fall back to the freeze rather than degrade to a grant.
   *
   * Callers bound this themselves. A decision somebody is waiting on must not
   * be held open by a session that has stopped answering.
   */
  declare(): Promise<HolderDeclaration | undefined>;
}

const holders = new Map<TaskId, BlanketHolderSession>();

/**
 * Publishes a way to ask this holder, for the lifetime of its execution.
 *
 * Answers the deregistration, which is identity-checked: a second run that has
 * since registered the same task id keeps its entry, so a late teardown cannot
 * unpublish somebody else's live session.
 */
export function registerBlanketHolder(
  session: BlanketHolderSession,
): () => void {
  holders.set(session.task.id, session);
  return () => {
    if (holders.get(session.task.id) === session) {
      holders.delete(session.task.id);
    }
  };
}

/**
 * The live holder with this task id, when one is executing in this process.
 *
 * `repositoryId` is checked rather than trusted: a task id is unique, but a
 * caller asking about the wrong repository is a bug that should answer nothing
 * rather than pause an unrelated agent.
 */
export function blanketHolderSession(
  taskId: TaskId,
  repositoryId?: string,
): BlanketHolderSession | undefined {
  const session = holders.get(taskId);
  if (session === undefined) {
    return undefined;
  }
  if (repositoryId !== undefined && session.repositoryId !== repositoryId) {
    return undefined;
  }
  return session;
}
