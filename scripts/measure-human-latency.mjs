#!/usr/bin/env node
/**
 * How long a person takes to answer something a run is waiting on.
 *
 * The coordination benchmark measures machine time and agent tokens. Neither
 * counts the expensive part of an integration failure: somebody has to notice
 * it, stop what they were doing, come back, and decide. That cost falls only
 * on the arm that had the failure, so leaving it out understates the case for
 * coordination by whatever it is worth — and nobody knew what it was worth.
 *
 * This does not estimate it. Every wait a person has actually been asked to
 * end is already in the audit chain as a request/decision pair sharing an id,
 * so the distribution is a query rather than a guess:
 *
 *   question_asked      -> question_answered | question_cancelled   (requestId)
 *   approval_requested  -> approval_decided                         (approvalId)
 *   scope_change_requested  -> scope_change_decided                 (requestId)
 *   scope_release_requested -> scope_release_decided                (requestId)
 *
 * Read from durable state only, so it runs against any control plane's
 * database without instrumenting anything.
 *
 * What it measures, stated plainly: the latency from "a run asked" to "a
 * person responded". That is the noticing and the context switch, which is
 * the dominant term. It is not the time to resolve a merge conflict, which
 * nothing here has ever been asked to do — see the caveat printed with the
 * results.
 *
 * Usage: node scripts/measure-human-latency.mjs [--database <path>] [--json]
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const databasePath = path.resolve(
  argument(
    "database",
    process.env["COORD_DATABASE"] ?? ".coordinator/coordination.db",
  ),
);
const asJson = process.argv.includes("--json");

const db = new DatabaseSync(databasePath, { readOnly: true });

/**
 * The four waits, each named by the event that opens it, the events that can
 * close it, and the field both carry.
 *
 * `cancelled` closes a wait as surely as `answered` does — it is what happens
 * when nobody came back before the deadline — so it is collected separately
 * rather than dropped. A population that only counts answered questions is a
 * population with the slowest responders filtered out of it.
 */
const WAITS = [
  {
    label: "agent question",
    opens: "question_asked",
    settles: ["question_answered"],
    abandons: ["question_cancelled"],
    key: "requestId",
  },
  {
    label: "approval gate",
    opens: "approval_requested",
    settles: ["approval_decided"],
    abandons: [],
    key: "approvalId",
    settledKey: "requestId",
  },
  {
    label: "scope change",
    opens: "scope_change_requested",
    settles: ["scope_change_decided"],
    abandons: [],
    key: "requestId",
  },
  {
    label: "scope release",
    opens: "scope_release_requested",
    settles: ["scope_release_decided"],
    abandons: [],
    key: "requestId",
  },
];

const rows = db
  .prepare(
    `SELECT type, task_id, data_json, occurred_at
       FROM audit_events
      WHERE type IN (${WAITS.flatMap((w) => [w.opens, ...w.settles, ...w.abandons])
        .map(() => "?")
        .join(",")})
      ORDER BY sequence`,
  )
  .all(...WAITS.flatMap((w) => [w.opens, ...w.settles, ...w.abandons]));

function identify(row, wait) {
  let data;
  try {
    data = JSON.parse(row.data_json);
  } catch {
    return undefined;
  }
  // The opening and closing events do not always spell the id the same way -
  // an approval opens with `approvalId` and closes with `requestId` - so both
  // spellings are accepted rather than the pair being silently dropped.
  const candidates = [wait.key, wait.settledKey, "requestId", "approvalId"];
  for (const name of candidates) {
    if (name !== undefined && typeof data[name] === "string") {
      return data[name];
    }
  }
  return undefined;
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return undefined;
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

function human(ms) {
  if (ms === undefined) return "-";
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

const report = [];
for (const wait of WAITS) {
  const opened = new Map();
  const answered = [];
  let abandoned = 0;
  let unmatched = 0;

  for (const row of rows) {
    const id = identify(row, wait);
    if (id === undefined) continue;
    if (row.type === wait.opens) {
      opened.set(id, Date.parse(row.occurred_at));
      continue;
    }
    const settles = wait.settles.includes(row.type);
    const abandons = wait.abandons.includes(row.type);
    if (!settles && !abandons) continue;
    const from = opened.get(id);
    if (from === undefined) {
      // A close with no open in this window - the request predates the
      // retention horizon. Counted, never guessed at.
      unmatched += 1;
      continue;
    }
    opened.delete(id);
    if (abandons) {
      abandoned += 1;
      continue;
    }
    const waited = Date.parse(row.occurred_at) - from;
    if (Number.isFinite(waited) && waited >= 0) {
      answered.push(waited);
    }
  }

  const sorted = [...answered].sort((a, b) => a - b);
  report.push({
    wait: wait.label,
    answered: sorted.length,
    // Still open at the end of the window, or abandoned at the deadline.
    abandoned,
    pending: opened.size,
    unmatched,
    medianMs: quantile(sorted, 0.5),
    p75Ms: quantile(sorted, 0.75),
    p90Ms: quantile(sorted, 0.9),
    maxMs: sorted.at(-1),
    meanMs:
      sorted.length === 0
        ? undefined
        : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  });
}

if (asJson) {
  console.log(JSON.stringify({ database: databasePath, waits: report }, undefined, 2));
} else {
  console.log(`\nHuman response latency, from ${databasePath}\n`);
  console.log(
    ["wait".padEnd(16), "answered".padEnd(10), "median".padEnd(9),
     "p75".padEnd(9), "p90".padEnd(9), "max".padEnd(9),
     "abandoned".padEnd(11), "pending"].join(""),
  );
  for (const row of report) {
    console.log(
      [
        row.wait.padEnd(16),
        String(row.answered).padEnd(10),
        human(row.medianMs).padEnd(9),
        human(row.p75Ms).padEnd(9),
        human(row.p90Ms).padEnd(9),
        human(row.maxMs).padEnd(9),
        String(row.abandoned).padEnd(11),
        String(row.pending),
      ].join(""),
    );
  }
  const total = report.reduce((sum, row) => sum + row.answered, 0);
  if (total === 0) {
    console.log(
      "\nNo completed waits in this database. Either nothing has asked a " +
        "person for anything, or the retention window has passed.",
    );
  }
  console.log(
    "\nWhat this is: the latency from a run asking to a person responding -\n" +
      "the noticing and the context switch. What it is not: the time to\n" +
      "resolve a merge conflict, which nothing recorded here was asked to do.\n" +
      "Read it as the floor on what an integration failure costs a human, not\n" +
      "as the whole of it.",
  );
}
