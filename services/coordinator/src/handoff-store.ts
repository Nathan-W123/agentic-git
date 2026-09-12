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
 * What a read of the handoff log found, and what it could not read.
 *
 * The handoffs alone are not a sufficient answer. A log with three damaged
 * rows and a log with three rows that were never written produce the same
 * array, and a successor handed that array cannot tell "nothing was handed
 * over" from "I could not read what was handed over" — which are the two
 * situations it must behave most differently in. So what could not be read is
 * counted and travels beside what could.
 */
export interface HandoffRead {
  /** The handoffs that could be read, newest first, capped by the query. */
  handoffs: TaskHandoff[];
  /**
   * Rows on the log, written under the handoff type, that are not readable as
   * handoffs — truncated, foreign, or written to a shape this code does not
   * know. Each one is a task's memory that exists and cannot be recovered.
   */
  unreadable: number;
  /** A whole leg of the log could not be read, so its contents are unknown. */
  incomplete: boolean;
}

/**
 * Finds handoffs worth seeding a new task with, and says what it could not read.
 *
 * Reads the archive as well as the live log, because a handoff that has been
 * compacted out of the live log is still the best record of what happened and
 * a successor has no other way to learn it — but only when the live log did
 * not already answer the question. `audit_events` is indexed by task, and
 * `audit_archive` is indexed by checkpoint, so the archive leg is a filtered
 * scan; a caller asking for one recent note is the common case and should not
 * pay for it. The price of the short circuit is that the rarer call makes two
 * round trips instead of one, which is the cheaper half of the trade.
 *
 * An archive that cannot be reached is reported rather than thrown, because
 * the live log in hand is worth more than the read that failed — but it is
 * reported, not swallowed: a seed short of the notes an unreachable archive
 * held is not the same thing as a repository that never wrote them.
 *
 * A live log that cannot be read does throw. There is no partial answer to
 * give in that case, and a caller that wants one can ask `seedContextForTask`,
 * which turns it into a stated unknown.
 */
export async function readTaskHandoffs(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<HandoffRead> {
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
  if (fromLive.handoffs.length >= limit) {
    return {
      handoffs: fromLive.handoffs.slice(0, limit),
      unreadable: fromLive.unreadable,
      incomplete: false,
    };
  }
  let archived: SequencedAuditEvent[] = [];
  let incomplete = false;
  try {
    archived = await readAuditPages(
      (page) => store.listArchivedAuditEvents(page),
      filter,
    );
  } catch {
    incomplete = true;
  }
  if (archived.length === 0) {
    return {
      handoffs: fromLive.handoffs.slice(0, limit),
      unreadable: fromLive.unreadable,
      incomplete,
    };
  }
  const merged = collectHandoffs([...live, ...archived], query);
  return {
    handoffs: merged.handoffs.slice(0, limit),
    unreadable: merged.unreadable,
    incomplete,
  };
}

/**
 * The handoffs a query selects, newest first.
 *
 * The plain answer, for callers that have nowhere to put the rest of it.
 * Anything that will be read by an agent should use `readTaskHandoffs` and
 * pass what it could not read on to the reader.
 */
export async function findTaskHandoffs(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<TaskHandoff[]> {
  return (await readTaskHandoffs(store, query)).handoffs;
}

/**
 * The handoffs in a batch of audit rows, newest first and deduplicated.
 *
 * Newest first because a successor wants the most recent state of the world,
 * and a stale handoff read first is worse than no handoff at all.
 *
 * A row of the handoff type whose payload will not read back as a handoff is
 * counted rather than passed over in silence. Something wrote a handoff there
 * — that is what the type means — and it cannot be recovered, so the one
 * honest thing left to do with it is to tell the reader a memory is missing.
 * Skipping it quietly would report a damaged log as a log with less on it.
 */
function collectHandoffs(
  entries: readonly SequencedAuditEvent[],
  query: HandoffQuery,
): { handoffs: TaskHandoff[]; unreadable: number } {
  const handoffs: TaskHandoff[] = [];
  const seen = new Set<string>();
  // By sequence, so a row the live log and the archive both answer with is one
  // damaged record rather than two.
  const unreadable = new Set<number>();
  for (const entry of [...entries].sort(
    (left, right) => right.sequence - left.sequence,
  )) {
    const candidate = entry.event.data["handoff"];
    if (!isTaskHandoff(candidate)) {
      // The repository the row belongs to is mirrored beside the payload, so
      // a repository-scoped read can tell a record damaged here from one
      // damaged elsewhere. A row that does not say is counted: a record that
      // might be this repository's and cannot be read is exactly the thing
      // this count exists to report.
      const owner = entry.event.data["repositoryId"];
      if (
        query.repositoryId === undefined ||
        typeof owner !== "string" ||
        owner === query.repositoryId
      ) {
        unreadable.add(entry.sequence);
      }
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
  return { handoffs, unreadable: unreadable.size };
}

/**
 * The context string a fresh task should start from.
 *
 * Empty when nothing relevant is on record *and* the whole record was read, so
 * a caller can concatenate it unconditionally without seeding a task with a
 * heading and no content.
 *
 * Never throws, and that is the point rather than a convenience. Every caller
 * of this function seeds a prompt with what it returns and cannot fail a run
 * over a note it could not fetch, so a throw here has always become `""` at
 * the call site — an unreadable log presented to the successor as a
 * repository that has never handed anything over. What a failed read produces
 * now is a block that says the log could not be read, which is the difference
 * between a session that knows to go and look and one that starts blind
 * believing it has seen everything.
 */
export async function seedContextForTask(
  store: CoordinationStore,
  query: HandoffQuery = {},
): Promise<string> {
  const read = await readTaskHandoffs(store, query).catch(
    (): HandoffRead => ({ handoffs: [], unreadable: 0, incomplete: true }),
  );
  return renderHandoffContext(read.handoffs, {
    unreadable: read.unreadable,
    incomplete: read.incomplete,
  });
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
  return events.filter((entry) => handoffRowReason(entry) === "long_running")
    .length;
}

/**
 * Why the task that wrote a handoff row stopped.
 *
 * `recordTaskHandoff` mirrors the reason beside the payload so the log can be
 * filtered without parsing every record, but the mirror is a copy and the
 * handoff is the original. A row written before the mirror existed, or by
 * anything else that puts a handoff on the log, carries the reason only
 * inside the record — and read through the mirror alone such a row counts for
 * nothing. That is the worse direction for this particular number to be wrong
 * in: a budget counted low hands a task another window it has already proved
 * it cannot use, and a task that keeps stopping keeps being requeued, which
 * is the loop `MAX_CONTEXT_HANDOFFS` exists to end.
 */
function handoffRowReason(entry: SequencedAuditEvent): string | undefined {
  const mirrored = entry.event.data["reason"];
  if (typeof mirrored === "string") {
    return mirrored;
  }
  const payload = entry.event.data["handoff"];
  if (typeof payload === "object" && payload !== null) {
    const reason = (payload as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  return undefined;
}
