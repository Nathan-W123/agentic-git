/**
 * Notifications — the events that actually warrant interrupting someone.
 *
 * Derived from the audit stream, but deliberately not a mirror of it: the
 * coordinator records everything it decides, and almost none of that needs a
 * person. What survives the filter is work finishing, work blocked, work
 * needing a decision, and work that failed.
 */

import { markRead, notifications, state, unreadCount } from "./data.js";
import {
  esc,
  icon,
  emptyState,
  relativeTime,
  tabs,
} from "./ui.js";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "approval", label: "Approvals" },
  { value: "failure", label: "Failures" },
];

const TONE_COLOR = {
  green: "var(--green)",
  red: "var(--red)",
  orange: "var(--orange)",
  blue: "var(--blue)",
  purple: "var(--accent-bright)",
  grey: "var(--text-3)",
};

function visible(rows) {
  if (state.notificationFilter === "unread") {
    return rows.filter((row) => !state.readNotifications.has(row.id));
  }
  if (state.notificationFilter === "approval") {
    return rows.filter((row) => row.kind === "approval");
  }
  if (state.notificationFilter === "failure") {
    return rows.filter((row) => row.kind === "failure" || row.kind === "conflict");
  }
  return rows;
}

function notificationRow(row) {
  const unread = !state.readNotifications.has(row.id);
  return `<button class="notif-row${unread ? " unread" : ""}"
    data-act="notif-open" data-value="${esc(row.id)}">
    <span class="nr-icon" style="color:${TONE_COLOR[row.tone] ?? "var(--text-3)"}">
      ${icon(row.iconName)}
    </span>
    <span style="min-width:0">
      <span class="nr-title">${esc(row.title)}</span>
      <div class="nr-body">${esc(row.body)}</div>
      ${
        row.taskId === undefined
          ? ""
          : `<div class="nr-meta"><span class="chip">${esc(
              String(row.agentId ?? "task"),
            )}</span></div>`
      }
    </span>
    <span class="nr-time">${esc(relativeTime(row.at))}</span>
  </button>`;
}

export function renderNotifications() {
  const rows = notifications();
  const shown = visible(rows);
  const unread = unreadCount();

  return `<div class="scroll"><div class="page">
    <div class="page-head">
      <span class="ph-icon">${icon("bell")}</span>
      <div>
        <h1>Notifications</h1>
        <p>${
          unread === 0
            ? "You are up to date."
            : `${unread} unread event${unread === 1 ? "" : "s"} need your attention.`
        }</p>
      </div>
      <span class="spacer"></span>
      <button class="btn" data-act="notif-read-all"${unread === 0 ? " disabled" : ""}>
        ${icon("check")} Mark all read
      </button>
    </div>

    <div class="notif-toolbar">
      ${tabs("notif-filter", FILTERS, state.notificationFilter)}
    </div>

    <section class="card">
      ${
        shown.length === 0
          ? emptyState(
              "bell",
              rows.length === 0 ? "Nothing yet" : "Nothing in this filter",
              rows.length === 0
                ? "Completed tasks, approvals, conflicts, and failures show up here."
                : "Try another filter.",
            )
          : `<div class="notif-list">${shown.map(notificationRow).join("")}</div>`
      }
    </section>
  </div></div>`;
}

export function readAll(rerender) {
  markRead(notifications().map((row) => row.id));
  rerender();
}

export function readOne(id, rerender) {
  markRead([id]);
  rerender();
}
