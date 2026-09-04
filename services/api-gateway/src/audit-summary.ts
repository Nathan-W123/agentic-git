/**
 * Rendering an audit event's data blob as one readable line.
 *
 * Audit rows carry whatever the emitting site put in them, so this cannot
 * assume a shape. It promotes the keys that carry meaning, drops the ones
 * that are noise in every event, and clips the rest.
 */

import { collapseWhitespace } from "./text.js";

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
      push(key, collapseWhitespace(value).slice(0, 200));
    }
  }
  const files = Array.isArray(data["files"]) ? data["files"].length : 0;
  if (files > 0) {
    push("files", String(files));
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
      push(key, collapseWhitespace(value).slice(0, 120));
      continue;
    }
    // A list is worth its length — which of a run's gates ran, how many files
    // it touched — and never its contents.
    if (Array.isArray(value) && value.length > 0) {
      push(key, String(value.length));
    }
  }
  return parts.join(" ").slice(0, AUDIT_SUMMARY_MAX_CHARS);
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
