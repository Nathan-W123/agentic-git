import type { CoordinationStore } from "@coord/persistence";
import type { TaskHandoff } from "@coord/shared-types";

import {
  HANDOFF_AUDIT_TYPE,
  handoffResources,
  isTaskHandoff,
  renderHandoffContext,
} from "./handoff.js";

/**
 * Where a handoff lives.
 *
 * The audit log, rather than a table of its own. That is not a shortcut: a
 * handoff is a statement about what happened, and the audit log is the one
 * store in this system that is append-only and hash-chained, so a handoff
 * cannot be quietly rewritten after the fact to say something more flattering.
 * It also means handoffs are already filtered by task, project and time, and
 * already travel with the audit export.
 *
 * The cost is real and worth stating plainly: audit events can be archived and
 * then pruned, and a pruned handoff is gone. Retrieval therefore reads the
 * archive as well as the live log, so archiving alone never loses one — but an
 * operator who prunes an archived segment is discarding handoffs along with
 * it. If handoffs are ever expected to outlive audit retention, they need a
 * table of their own; today they do not.
 */

export interface RecordHandoffOptions {
  /** Run to attribute the record to, when the task reached one. */
  runId?: string;
}

export async function recordTaskHandoff(
  store: CoordinationStore,
  handoff: TaskHandoff,
  options: RecordHandoffOptions = {},
): Promise<void> {
  await store.appendAudit(options.runId ?? handoff.runId, {
    type: HANDOFF_AUDIT_TYPE,
    taskId: handoff.taskId,
    data: {
      ...(handoff.projectId === undefined
        ? {}
        : { projectId: handoff.projectId }),
      repositoryId: handoff.repositoryId,
      reason: handoff.reason,
      handoff,
    },
  });
}

export interface HandoffQuery {
  taskId?: string;
  projectId?: string;
  repositoryId?: string;
  /** Only handoffs touching one of these resources. */
  resources?: readonly string[];
  /** Newest first, capped. Defaults to 5 — a seed, not an archive dump. */
  limit?: number;
}

/**
 * Finds handoffs worth seeding a new task with.
 *
 * Reads the archive as well as the live log, because a handoff that has been
 * compacted out of the live log is still the best record of what happened and
 * a successor has no other way to learn it.
 */
export async function findTaskHandoffs(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<TaskHandoff[]> {
  const filter = {
    types: [HANDOFF_AUDIT_TYPE],
    ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
  };
  const [live, archived] = await Promise.all([
    store.listAuditEvents(filter),
    store.listArchivedAuditEvents(filter).catch(() => []),
  ]);

  const handoffs: TaskHandoff[] = [];
  const seen = new Set<string>();
  // Newest first: a successor wants the most recent state of the world, and a
  // stale handoff read first is worse than no handoff at all.
  for (const entry of [...live, ...archived].sort(
    (left, right) => right.sequence - left.sequence,
  )) {
    const candidate = entry.event.data["handoff"];
    if (!isTaskHandoff(candidate)) {
      continue;
    }
    const key = `${candidate.taskId}\0${candidate.createdAt}`;
    if (seen.has(key)) {
      continue;
    }
    if (
      query.repositoryId !== undefined &&
      candidate.repositoryId !== query.repositoryId
    ) {
      continue;
    }
    if (query.resources !== undefined && query.resources.length > 0) {
      const touched = new Set(handoffResources(candidate));
      const overlaps = query.resources.some((resource) =>
        touched.has(resource),
      );
      if (!overlaps) {
        continue;
      }
    }
    seen.add(key);
    handoffs.push(candidate);
  }
  return handoffs.slice(0, query.limit ?? 5);
}

/**
 * The context string a fresh task should start from.
 *
 * Empty when nothing relevant is on record, so a caller can concatenate it
 * unconditionally without seeding a task with a heading and no content.
 */
export async function seedContextForTask(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<string> {
  return renderHandoffContext(await findTaskHandoffs(store, query));
}
