/**
 * Rendering an audit event's data blob as one readable line.
 *
 * Audit rows carry whatever the emitting site put in them, so this cannot
 * assume a shape. It promotes the keys that carry meaning, drops the ones
 * that are noise in every event, and clips the rest.
 */

import { clipCodeUnits, collapseWhitespace } from "./text.js";

/**
 * The fields of an audit event that say what happened, richest first.
 *
 * These come out in this order whatever order the payload was written in, so
 * a trail of a dozen events reads the same way down the page.
 */
export const AUDIT_SUMMARY_PRIORITY_KEYS = [
  "status",
  "explanation",
  "error",
  "reason",
  "message",
] as const;

/**
 * Fields no summary ever carries.
 *
 * Either bulk — plan JSON, patch text, captured output — which is what the
 * summary exists to keep out, or identifiers, which differ on every run and
 * tell a reader of the trail nothing about what happened.
 */
export const AUDIT_SUMMARY_SKIP_KEYS = new Set([
  "patch",
  "diff",
  "output",
  "stdout",
  "stderr",
  "plan",
  "prompt",
  "content",
  "body",
  "raw",
  "log",
  "logs",
  "transcript",
  "files",
  "taskId",
  "repositoryId",
  "projectId",
  "messageId",
  "sessionId",
  "agentId",
  "id",
]);

/** How long one event's summary may run. */
export const AUDIT_SUMMARY_MAX_CHARS = 400;

/**
 * What stands at the end of anything this file shortened.
 *
 * Every cut here used to be invisible: a value sliced at 200 characters and
 * a summary sliced at 400 both came out looking like the whole of what the
 * event said. That is the one failure this file must not have — an
 * investigator reading `error=the gate passed on the second` decides the run
 * recovered, when the sentence went on to say it did not.
 */
export const AUDIT_SUMMARY_CLIP_MARK = "…";

/**
 * `value` in at most `maxChars` characters, saying so when it did not fit.
 *
 * The mark is load-bearing rather than decoration: a clipped value is not a
 * shorter value, it is a value whose end is unknown, and the reader has to be
 * able to tell those apart.
 */
function clipValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const room = Math.max(0, maxChars - AUDIT_SUMMARY_CLIP_MARK.length);
  return `${clipCodeUnits(value, room).trimEnd()}${AUDIT_SUMMARY_CLIP_MARK}`;
}

/**
 * What a field this file has no rendering for is worth saying about.
 *
 * A nested object under `error` or `verdict` used to summarise to nothing at
 * all, so an event that recorded a failure in structured form reached the
 * reader as an event that recorded nothing. The field is still not worth its
 * contents — that is what the whole file is for — but its existence is: an
 * unread field has to read as unread and never as absent.
 */
export const AUDIT_SUMMARY_UNREAD_MARK = "{…}";

/**
 * One audit event's data as a short line for a prompt.
 *
 * The trail is read for its shape — planned, admitted, asked for scope, died
 * — so each entry needs enough to be recognised and no more. Sending whole
 * payloads would spend most of the context on plan JSON and patch text.
 *
 * The fields that usually carry the story come first and in a fixed order;
 * everything else small enough to be worth a few characters follows, because
 * a strict allowlist meant the one field that explained a failure — a line
 * number, an exit code, a gate name — never reached the model when it was
 * exactly what the question was about.
 */
export function summariseAuditData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: string): void => {
    seen.add(key);
    parts.push(`${key}=${value}`);
  };
  for (const key of AUDIT_SUMMARY_PRIORITY_KEYS) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      push(key, clipValue(collapseWhitespace(value), 200));
    }
  }
  if (Array.isArray(data["files"])) {
    // Including none: a run that changed nothing is a fact about the run,
    // and leaving it out makes it indistinguishable from an event that never
    // said either way.
    push("files", String(data["files"].length));
  }
  for (const [key, value] of Object.entries(data)) {
    if (seen.has(key) || AUDIT_SUMMARY_SKIP_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      push(key, String(value));
      continue;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      push(key, clipValue(collapseWhitespace(value), 120));
      continue;
    }
    // A list is worth its length — which of a run's gates ran, how many files
    // it touched — and never its contents.
    if (Array.isArray(value)) {
      push(key, String(value.length));
      continue;
    }
    // Anything else — a nested object, a value written by a newer version of
    // the emitting site — is named and not read. Dropping it entirely was
    // the same as the event never carrying it.
    if (typeof value === "object" && value !== null) {
      push(key, AUDIT_SUMMARY_UNREAD_MARK);
    }
  }
  return joinWithinCap(parts);
}

/**
 * The parts as one line, cut between fields rather than through one.
 *
 * Slicing the joined string at the cap is what made this dangerous: the cut
 * lands wherever it lands, so `exitCode=137` arrives as `exitCode=1` and the
 * reader has no way to know. A whole field or none, and a mark when fields
 * were left off, keeps every value that is shown a value that was recorded.
 */
function joinWithinCap(parts: readonly string[]): string {
  const whole = parts.join(" ");
  if (whole.length <= AUDIT_SUMMARY_MAX_CHARS) {
    return whole;
  }
  const limit = AUDIT_SUMMARY_MAX_CHARS - AUDIT_SUMMARY_CLIP_MARK.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const cost = (kept.length === 0 ? 0 : 1) + part.length;
    if (used + cost > limit) {
      break;
    }
    kept.push(part);
    used += cost;
  }
  if (kept.length === 0) {
    // One field on its own longer than the whole cap. Its name still says
    // which field the reader is not being shown.
    const first = parts[0] ?? "";
    const split = first.indexOf("=");
    const name = split < 0 ? first : first.slice(0, split);
    return clipValue(
      `${name}=${AUDIT_SUMMARY_CLIP_MARK}`,
      AUDIT_SUMMARY_MAX_CHARS,
    );
  }
  return `${kept.join(" ")} ${AUDIT_SUMMARY_CLIP_MARK}`;
}

/**
 * The changed-file list out of a run's audit event, in either shape it takes.
 *
 * `workspace_changed` reports under `files` while the agent is still working;
 * `changeset_collected` reports the final set under `changedFiles`, keeping
 * its own `files` as bare paths because the narration already reads that.
 * Both are validated rather than trusted: this decorates a thread, and an
 * event written by a newer version must cost the reader a dropdown at worst.
 */
