/**
 * What happened while somebody was away, in as few words as it can be put.
 *
 * Everything here is pure — counts and timestamps in, a short document out —
 * so what the popup says can be tested without a server, a store or a model.
 * The gathering that feeds it lives in `server.ts`.
 *
 * The whole point is brevity. Somebody opening the app after a night away
 * wants to know whether anything landed, whether anything broke, and whether
 * they were talked to; a transcript of the interval is what they already have
 * in the channel. So each kind of news gets at most a line or two, and a quiet
 * interval produces nothing at all rather than a document saying so.
 */

/** Which kind of news a line stands for, so the client can style it. */
export type CatchUpSource = "landed" | "failed" | "messages" | "direct";

export interface CatchUpLine {
  source: CatchUpSource;
  /** One short sentence, already written for a reader in a hurry. */
  text: string;
  /** The newest thing this line stands for, which is what orders the list. */
  at: string;
}

/** One finished piece of work, as the digest needs it. */
export interface CatchUpChange {
  objective: string;
  at: string;
}

export interface CatchUpInput {
  /** The viewer's watermark: everything after this is news. */
  since: string;
  now: string;
  landed: readonly CatchUpChange[];
  failed: readonly CatchUpChange[];
  /** When each channel entry somebody else wrote since `since` was written. */
  messages: readonly string[];
  /** Direct messages waiting unread for the viewer. */
  direct: number;
}

export interface CatchUpDigest {
  since: string;
  generatedAt: string;
  /** Nothing to show. The client opens no popup at all for one of these. */
  empty: boolean;
  headline: string;
  lines: CatchUpLine[];
  counts: {
    landed: number;
    failed: number;
    messages: number;
    direct: number;
  };
}

/**
 * The most lines the document may carry.
 *
 * Six is what fits on a phone without scrolling, and a catch-up somebody has
 * to scroll is one they will close unread — which is the failure this exists
 * to avoid. Anything past the cap is counted rather than listed.
 */
export const CATCH_UP_MAX_LINES = 6;

/** How many landed changes are named individually before they are counted. */
const CATCH_UP_NAMED_CHANGES = 3;

/**
 * The furthest back a catch-up will ever look.
 *
 * Somebody returning after a month does not want a month; they want to know
 * what the project looks like now, and the interval stops being "since you
 * left" and starts being "the history". Two weeks is the point where the
 * document would stop being readable in one glance either way.
 */
export const CATCH_UP_MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** How much of an objective survives into a line. */
const OBJECTIVE_MAX = 72;

/**
 * The window to report, or nothing when there is no window worth reporting.
 *
 * A viewer with no watermark has never been here before, and somebody's first
 * visit has no "while you were away" — so they are handed nothing rather than
 * whatever the project happens to have done before they arrived. An old
 * watermark is clamped forward instead of honoured, for the reason
 * {@link CATCH_UP_MAX_LOOKBACK_MS} gives.
 */
export function catchUpSince(
  cursor: string | undefined,
  now: string,
): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const floor = new Date(Date.parse(now) - CATCH_UP_MAX_LOOKBACK_MS)
    .toISOString();
  return cursor > floor ? cursor : floor;
}

/** A document with no news in it, for a quiet interval or a first visit. */
export function emptyCatchUpDigest(
  since: string,
  now: string,
): CatchUpDigest {
  return {
    since,
    generatedAt: now,
    empty: true,
    headline: "",
    lines: [],
    counts: { landed: 0, failed: 0, messages: 0, direct: 0 },
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** Clips an objective to a whole word, so a line never ends mid-syllable. */
function clip(objective: string): string {
  const trimmed = objective.replace(/\s+/gu, " ").trim();
  if (trimmed.length <= OBJECTIVE_MAX) {
    return trimmed;
  }
  const cut = trimmed.slice(0, OBJECTIVE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function newestFirst(
  changes: readonly CatchUpChange[],
): CatchUpChange[] {
  return [...changes].sort((left, right) => right.at.localeCompare(left.at));
}

function newest(times: readonly string[], fallback: string): string {
  return times.reduce((latest, at) => (at > latest ? at : latest), fallback);
}

/**
 * The catch-up itself.
 *
 * Landed work is named, because "what changed" is the question being asked.
 * Everything else is counted: a failure the reader has to go and look at is
 * one line whether it is one task or five, and a message count is more useful
 * than five truncated quotes.
 */
export function buildCatchUpDigest(input: CatchUpInput): CatchUpDigest {
  const landed = newestFirst(input.landed);
  const failed = newestFirst(input.failed);
  const messages = input.messages.length;
  const direct = Math.max(0, input.direct);
  const counts = {
    landed: landed.length,
    failed: failed.length,
    messages,
    direct,
  };
  if (
    landed.length === 0 &&
    failed.length === 0 &&
    messages === 0 &&
    direct === 0
  ) {
    return emptyCatchUpDigest(input.since, input.now);
  }

  const lines: CatchUpLine[] = [];
  for (const change of landed.slice(0, CATCH_UP_NAMED_CHANGES)) {
    lines.push({ source: "landed", text: clip(change.objective), at: change.at });
  }
  const unnamed = landed.length - CATCH_UP_NAMED_CHANGES;
  if (unnamed > 0) {
    lines.push({
      source: "landed",
      text: `and ${plural(unnamed, "more change", "more changes")}`,
      at: landed[CATCH_UP_NAMED_CHANGES]?.at ?? input.since,
    });
  }
  if (failed.length > 0) {
    const first = failed[0];
    lines.push({
      source: "failed",
      text:
        failed.length === 1 && first !== undefined
          ? `Didn't finish: ${clip(first.objective)}`
          : `${failed.length} tasks didn't finish`,
      at: first?.at ?? input.since,
    });
  }
  if (messages > 0) {
    lines.push({
      source: "messages",
      text: `${plural(messages, "new message", "new messages")}`,
      at: newest(input.messages, input.since),
    });
  }
  if (direct > 0) {
    lines.push({
      source: "direct",
      text: `${plural(direct, "unread direct message", "unread direct messages")}`,
      at: input.now,
    });
  }

  return {
    since: input.since,
    generatedAt: input.now,
    empty: false,
    headline: headlineFor(counts),
    lines: lines.slice(0, CATCH_UP_MAX_LINES),
    counts,
  };
}

/** The one fact that matters most, which is the only line everybody reads. */
function headlineFor(counts: CatchUpDigest["counts"]): string {
  if (counts.landed > 0) {
    return `${plural(counts.landed, "change", "changes")} landed while you were away`;
  }
  if (counts.failed > 0) {
    return `Nothing landed, and ${plural(counts.failed, "task", "tasks")} stopped`;
  }
  if (counts.messages > 0) {
    return `${plural(counts.messages, "new message", "new messages")} while you were away`;
  }
  return `${plural(counts.direct, "unread direct message", "unread direct messages")}`;
}

/**
 * The digest as plain text, for anywhere that wants it as one string.
 *
 * A quiet interval formats to nothing, so a caller can test the string for
 * emptiness instead of testing the flag and then the lines.
 */
export function formatCatchUpDocument(digest: CatchUpDigest): string {
  if (digest.empty) {
    return "";
  }
  return [digest.headline, ...digest.lines.map((line) => `• ${line.text}`)]
    .join("\n");
}
