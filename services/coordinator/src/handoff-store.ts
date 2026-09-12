import type { AuditEventFilter, CoordinationStore } from "@coord/persistence";
import type { SequencedAuditEvent, TaskHandoff } from "@coord/shared-types";

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

/**
 * How many audit rows one read of the log asks for.
 *
 * The log answers a page, not a table: `listAuditEvents` returns at most
 * `limit` rows — five hundred when none is asked for, five thousand at the
 * very most — ordered oldest first. So a single unsized read of a log that has
 * outgrown one page answers with the *oldest* rows and never with the newest,
 * which is the one way this module can fail without saying so: the seed would
 * show a successor the handoffs from the repository's first week and nothing
 * to suggest a newer one exists. Every read here is therefore a walk, and it
 * asks for the largest page the store will answer so the walk is as short as
 * the store allows. A log that fits in one page — which is every deployment
 * until it is not — still costs exactly one round trip.
 */
export const AUDIT_PAGE_SIZE = 5_000;

/**
 * Every audit row matching a filter, oldest first.
 *
 * Stops when a page comes back short, which is the log saying there is no
 * more. Also stops when a page does not advance the cursor, so a store that
 * ignores `afterSequence` costs one extra read rather than looping forever on
 * the same page.
 */
async function readAuditPages(
  read: (filter: AuditEventFilter) => Promise<SequencedAuditEvent[]>,
  filter: AuditEventFilter,
): Promise<SequencedAuditEvent[]> {
  const all: SequencedAuditEvent[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await read({
      ...filter,
      afterSequence,
      limit: AUDIT_PAGE_SIZE,
    });
    all.push(...page);
    const last = page.at(-1);
    if (
      page.length < AUDIT_PAGE_SIZE ||
      last === undefined ||
      last.sequence <= afterSequence
    ) {
      return all;
    }
    afterSequence = last.sequence;
  }
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
 * a successor has no other way to learn it — but only when the live log did
 * not already answer the question. `audit_events` is indexed by task, and
 * `audit_archive` is indexed by checkpoint, so the archive leg is a filtered
 * scan; a caller asking for one recent note is the common case and should not
 * pay for it. The price of the short circuit is that the rarer call makes two
 * round trips instead of one, which is the cheaper half of the trade.
 */
export async function findTaskHandoffs(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<TaskHandoff[]> {
  const filter: AuditEventFilter = {
    types: [HANDOFF_AUDIT_TYPE],
    ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
  };
  const limit = query.limit ?? 5;
  const live = await readAuditPages(
    (page) => store.listAuditEvents(page),
    filter,
  );
  const fromLive = collectHandoffs(live, query);
  if (fromLive.length >= limit) {
    return fromLive.slice(0, limit);
  }
  const archived = await readAuditPages(
    (page) => store.listArchivedAuditEvents(page),
    filter,
  ).catch(() => []);
  if (archived.length === 0) {
    return fromLive.slice(0, limit);
  }
  return collectHandoffs([...live, ...archived], query).slice(0, limit);
}

/**
 * The handoffs in a batch of audit rows, newest first and deduplicated.
 *
 * Newest first because a successor wants the most recent state of the world,
 * and a stale handoff read first is worse than no handoff at all.
 */
function collectHandoffs(
  entries: readonly SequencedAuditEvent[],
  query: HandoffQuery,
): TaskHandoff[] {
  const handoffs: TaskHandoff[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort(
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
  return handoffs;
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

/**
 * How many times one task may stop itself for context pressure.
 *
 * Two handoffs is a task that twice filled a window and was twice reseeded
 * with everything the control plane knows about it. A third stop is a task
 * that does not fit, and the honest ending for that is a failure that says so
 * rather than a queue it circles forever.
 */
export const MAX_CONTEXT_HANDOFFS = 2;

/**
 * How many context handoffs this task has already spent.
 *
 * Counted from the audit log rather than from a column, because that is where
 * the handoffs themselves live and a second source of truth for the same fact
 * is a second thing to keep in step. The trade is the one stated above: a
 * pruned archive segment resets the count, which costs at most one more budget
 * for that task — cheaper than two migrations and a parity test for a number
 * the log already holds.
 *
 * Reads the live log only. A task requeued for pressure is re-leased within
 * minutes, so the archive would only matter for one left idle longer than the
 * deployment's audit retention, and this runs on the lease path.
 */
export async function contextHandoffsUsed(
  store: CoordinationStore,
  taskId: string,
): Promise<number> {
  const events = await readAuditPages((page) => store.listAuditEvents(page), {
    types: [HANDOFF_AUDIT_TYPE],
    taskId,
  });
  return events.filter((entry) => entry.event.data["reason"] === "long_running")
    .length;
}
