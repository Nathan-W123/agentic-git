/**
 * Kumi — the Settings surface, and the pieces it is built from.
 *
 * Everything here is pure: a function takes what it needs and returns markup
 * or a plain value. Live state, the network and the router stay in `app.js`,
 * which composes these into the dialog. That split is what lets the shape of
 * a setting row be tested without a browser, and it is why the section
 * builders in `app.js` read as a list of rows rather than a wall of HTML.
 *
 * The visual system is Kumi's own warm neutrals and peach, sized to one
 * ramp — 20/24 for a page title, 15/20 for a section heading, 14/20 for body
 * and controls, 12.5/18 for the supporting line under a label — on an 8px
 * spacing grid. Spacing and a single hairline separate one group of settings
 * from the next; nothing in here draws a card inside a card.
 */

import { esc, icon } from "./ui.js";

/** The categories, in the order the sidebar lists them. */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    iconName: "gear",
    description: "Your profile, how Kumi looks, and everyday preferences.",
  },
  {
    id: "agents",
    label: "Agents",
    iconName: "robot",
    description: "The coding agents connected to your account.",
  },
  {
    id: "integrations",
    label: "Integrations",
    iconName: "link",
    description: "External accounts Kumi can use on your behalf.",
  },
  {
    id: "workspace",
    label: "Workspace",
    iconName: "users",
    description: "Who is in this workspace, and what it has been used for.",
  },
  {
    id: "billing",
    label: "Billing",
    iconName: "chart",
    description: "Your plan, what it covers, and who counts as a seat.",
  },
  {
    id: "project-controls",
    label: "Project controls",
    iconName: "sliders",
    description: "Repository, approval policy and app tokens for this project.",
  },
  {
    id: "deployment",
    label: "Deployment",
    iconName: "database",
    description: "How this control plane is doing, for whoever runs it.",
    adminOnly: true,
  },
];

/**
 * Old ids that must keep working.
 *
 * Two categories were renamed for what they actually hold rather than for
 * what they were once called. A bookmark, a stored `settingsSection`, or a
 * `#advanced` link written before the rename all still name a real category —
 * they are translated here rather than being dropped on the floor.
 */
export const SETTINGS_SECTION_ALIASES = {
  connections: "integrations",
  advanced: "project-controls",
};

/** The sidebar's two levels: a heading, then the categories under it. */
export const SETTINGS_GROUPS = [
  {
    id: "personal",
    label: "Personal",
    sections: ["general", "agents", "integrations"],
  },
  {
    id: "workspace",
    label: "Workspace",
    sections: ["workspace", "billing", "project-controls"],
  },
  { id: "system", label: "System", sections: ["deployment"] },
];

/** The category a value names, with aliases resolved and junk sent home. */
export function normalizeSettingsSection(value, allowed) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  const resolved = SETTINGS_SECTION_ALIASES[raw] ?? raw;
  const ids =
    allowed ?? SETTINGS_SECTIONS.map((section) => section.id);
  return ids.includes(resolved) ? resolved : "general";
}

/**
 * The category a URL fragment asks for, or `undefined` when it asks for none.
 *
 * Settings is a value carried alongside the chat route rather than a route of
 * its own — `#chats/LATTICE/main?channel=…&settings=general` — so opening and
 * closing it never disturbs the conversation underneath. The two bare legacy
 * hashes still answer, because links to them exist.
 */
export function settingsSectionFromHash(hash) {
  const raw = String(hash ?? "").replace(/^#/u, "");
  const [path, query = ""] = raw.split("?");
  if (path === "settings" || path === "advanced") {
    return normalizeSettingsSection(path);
  }
  let value = null;
  try {
    value = new URLSearchParams(query).get("settings");
  } catch {
    value = null;
  }
  if (value === null || value === "") {
    return undefined;
  }
  return normalizeSettingsSection(value);
}

/**
 * Every row somebody could go looking for, and the words they might use.
 *
 * Search is over five fields — the label, the supporting line, the section,
 * the heading the row sits under, and a list of synonyms — because the name
 * a product gives a setting is rarely the name its owner has for it. "Dark"
 * is the obvious case: nothing on the appearance row says the word, and it is
 * the single most likely thing to be typed.
 *
 * `row` is the anchor id the section markup carries, so a result can scroll
 * to and focus the exact row rather than the top of a page.
 */
export const SETTINGS_SEARCH_INDEX = [
  {
    row: "profile",
    section: "general",
    group: "Profile",
    label: "Profile",
    description: "Your name, email and picture across this Kumi workspace.",
    synonyms: ["account", "name", "email", "avatar", "picture", "photo", "me"],
  },
  {
    row: "theme",
    section: "general",
    group: "Appearance",
    label: "Theme",
    description: "Follow your device, or keep Kumi light or dark.",
    synonyms: [
      "dark",
      "dark mode",
      "light",
      "light mode",
      "night",
      "system",
      "appearance",
      "colour scheme",
      "color scheme",
      "contrast",
    ],
  },
  {
    row: "profile-colours",
    section: "general",
    group: "Appearance",
    label: "Profile colours",
    description:
      "Your primary and secondary colours, and the colour your agents wear.",
    synonyms: [
      "colour",
      "color",
      "colours",
      "colors",
      "accent",
      "primary",
      "secondary",
      "agent colour",
      "agent color",
      "palette",
      "swatch",
    ],
  },
  {
    row: "sounds",
    section: "general",
    group: "Preferences",
    label: "Sound effects",
    description: "Quiet cues for messages and finished work, on this device.",
    synonyms: ["sound", "audio", "chime", "mute", "notification sound", "volume"],
  },
  {
    row: "sign-out",
    section: "general",
    group: "Session",
    label: "Sign out",
    description: "End this session on this device.",
    synonyms: ["logout", "log out", "sign off", "session", "leave"],
  },
  {
    row: "agent-providers",
    section: "agents",
    group: "Agents",
    label: "Connected agents",
    description: "Connect, rename and disconnect the agents that belong to you.",
    synonyms: [
      "claude",
      "codex",
      "openai",
      "cursor",
      "copilot",
      "gemini",
      "cli",
      "provider",
      "connect",
      "disconnect",
      "rename",
    ],
  },
  {
    row: "github",
    section: "integrations",
    group: "Integrations",
    label: "GitHub",
    description: "Push and pull as you, from the agents you ask to do it.",
    synonyms: ["git", "repo", "remote", "oauth", "push", "integration", "connect"],
  },
  {
    row: "workspace-identity",
    section: "workspace",
    group: "Workspace",
    label: "Workspace",
    description: "Which workspace these settings belong to.",
    synonyms: ["project", "team", "organisation", "organization", "identity"],
  },
  {
    row: "invitations",
    section: "workspace",
    group: "Invitations",
    label: "Pending invitations",
    description: "People who have been invited and have not joined yet.",
    synonyms: ["invite", "invitation", "people", "members", "revoke", "join"],
  },
  {
    row: "workspace-activity",
    section: "workspace",
    group: "Activity",
    label: "Channel activity",
    description: "Messages, replies and tokens in the open channel.",
    synonyms: ["stats", "usage", "tokens", "messages", "replies", "metrics"],
  },
  {
    row: "billing-plan",
    section: "billing",
    group: "Plan",
    label: "Plan",
    description: "What this team is subscribed to, and what happens next.",
    synonyms: ["subscription", "trial", "stripe", "payment", "invoice", "card"],
  },
  {
    row: "billing-seats",
    section: "billing",
    group: "Plan",
    label: "Seats",
    description: "Everyone who can start work counts as a seat.",
    synonyms: ["seat", "price", "cost", "per user", "licence", "license"],
  },
  {
    row: "repository",
    section: "project-controls",
    group: "Repository",
    label: "Repository",
    description: "The repository the control plane owns, and its branch.",
    synonyms: ["git", "branch", "remote", "canonical", "push", "origin"],
  },
  {
    row: "approvals-enabled",
    section: "project-controls",
    group: "Approval policy",
    label: "Human approval",
    description: "Gate risky plans and changesets on a reviewer.",
    synonyms: ["approval", "review", "gate", "policy", "guardrail"],
  },
  {
    row: "approvals-schema",
    section: "project-controls",
    group: "Approval policy",
    label: "Review schema changes",
    description: "Pause whenever a plan touches a schema.",
    synonyms: ["schema", "migration", "database", "review"],
  },
  {
    row: "approvals-changeset",
    section: "project-controls",
    group: "Approval policy",
    label: "Review every changeset",
    description: "Pause on the diff as well as the plan.",
    synonyms: ["diff", "changeset", "review", "always"],
  },
  {
    row: "protected-paths",
    section: "project-controls",
    group: "Approval policy",
    label: "Protected paths",
    description: "One glob per line. Changes here always need review.",
    synonyms: ["glob", "path", "protected", "codeowners", "guard"],
  },
  {
    row: "approval-timeout",
    section: "project-controls",
    group: "Approval policy",
    label: "Approval timeout",
    description: "Minutes before an unanswered request expires.",
    synonyms: ["timeout", "expiry", "minutes", "deadline"],
  },
  {
    row: "task-runtime",
    section: "project-controls",
    group: "Approval policy",
    label: "Task runtime budget",
    description: "Minutes one task may run before it is stopped.",
    synonyms: ["budget", "runtime", "limit", "minutes", "cap"],
  },
  {
    row: "daily-runtime",
    section: "project-controls",
    group: "Approval policy",
    label: "Daily runtime budget",
    description: "Minutes every task in this project may run in a day.",
    synonyms: ["budget", "daily", "runtime", "limit", "minutes", "cap"],
  },
  {
    row: "app-tokens",
    section: "project-controls",
    group: "App tokens",
    label: "App tokens",
    description: "Sign a Kumi app on your machine into this account.",
    synonyms: ["token", "api key", "desktop", "cli", "revoke", "secret"],
  },
  {
    row: "mcp-servers",
    section: "project-controls",
    group: "MCP servers",
    label: "MCP servers",
    description:
      "Programs your agents can reach while they work, approved per project.",
    synonyms: ["mcp", "tools", "linear", "sentry", "server", "approve"],
  },
];

/**
 * Rows matching a query, best first.
 *
 * Scored rather than filtered so "theme" puts the theme row above the three
 * rows whose supporting text happens to contain the word. A term has to be
 * found somewhere in every candidate — an unmatched word means the person is
 * asking for something else, not for a looser version of this.
 */
export function searchSettings(query, options = {}) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return [];
  }
  const allowed = options.sections;
  const labelOf = (id) =>
    SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? id;
  const scored = [];
  for (const entry of SETTINGS_SEARCH_INDEX) {
    if (allowed !== undefined && !allowed.includes(entry.section)) {
      continue;
    }
    const label = entry.label.toLowerCase();
    const description = entry.description.toLowerCase();
    const group = entry.group.toLowerCase();
    const section = labelOf(entry.section).toLowerCase();
    const synonyms = (entry.synonyms ?? []).map((word) => word.toLowerCase());
    let total = 0;
    let matchedEvery = true;
    for (const term of terms) {
      let best = 0;
      if (label === term) {
        best = 120;
      } else if (label.startsWith(term)) {
        best = 100;
      } else if (label.includes(term)) {
        best = 80;
      } else if (synonyms.some((word) => word === term)) {
        best = 70;
      } else if (synonyms.some((word) => word.startsWith(term))) {
        best = 60;
      } else if (synonyms.some((word) => word.includes(term))) {
        best = 45;
      } else if (section.includes(term)) {
        best = 35;
      } else if (group.includes(term)) {
        best = 30;
      } else if (description.includes(term)) {
        best = 20;
      }
      if (best === 0) {
        matchedEvery = false;
        break;
      }
      total += best;
    }
    if (matchedEvery) {
      scored.push({
        ...entry,
        sectionLabel: labelOf(entry.section),
        score: total,
      });
    }
  }
  return scored.sort((left, right) =>
    right.score === left.score
      ? left.label.localeCompare(right.label)
      : right.score - left.score,
  );
}

/**
 * A large count, short enough to read at a glance.
 *
 * The exact number is never thrown away — `exactCountLabel` is what goes on
 * the accessible label and the tooltip — because "142.3M" is the readable
 * answer and "142,318,904" is the true one, and an activity strip owes the
 * reader both.
 */
export function abbreviateCount(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return "0";
  }
  const sign = number < 0 ? "-" : "";
  const size = Math.abs(number);
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (size >= scale) {
      // Truncated rather than rounded: a recap that says 143M of something
      // there are 142.9M of has overstated it, and one decimal is the whole
      // budget for precision here.
      const scaled = Math.floor((size / scale) * 10) / 10;
      const shown = Number.isInteger(scaled)
        ? String(scaled)
        : scaled.toFixed(1);
      return `${sign}${shown}${suffix}`;
    }
  }
  return `${sign}${String(Math.round(size))}`;
}

/** The exact figure, spelled out for a screen reader and a tooltip. */
export function exactCountLabel(value, noun) {
  const number = Number(value ?? 0);
  const exact = (Number.isFinite(number) ? number : 0).toLocaleString();
  return noun === undefined ? exact : `${exact} ${noun}`;
}

/* ------------------------------------------------------- primitives ---- */

/** The sticky title over a category's content, with its close control. */
export function settingsPageHeader({ title, description }) {
  return `<header class="st-page-head">
    <div class="st-page-title">
      <h2 id="settings-title">${esc(title)}</h2>
      ${description === undefined || description === "" ? "" : `<p>${esc(description)}</p>`}
    </div>
    <button type="button" class="st-close" data-act="settings-close"
      aria-label="Close settings" title="Close settings">${icon("close")}</button>
  </header>`;
}

/**
 * One run of settings under a heading.
 *
 * A section is spacing and a rule, not a card. Nesting a bordered box inside
 * a bordered dialog is how a settings page ends up drawing a dozen frames
 * around a single subject.
 */
export function settingsSectionBlock({
  id,
  heading,
  description = "",
  body = "",
  action = "",
}) {
  const headingId = `st-heading-${esc(String(id))}`;
  return `<section class="st-section" data-settings-section-block="${esc(String(id))}"
    aria-labelledby="${headingId}">
    <div class="st-section-head">
      <div class="st-section-title">
        <h3 id="${headingId}">${esc(heading)}</h3>
        ${description === "" ? "" : `<p>${esc(description)}</p>`}
      </div>
      ${action === "" ? "" : `<div class="st-section-action">${action}</div>`}
    </div>
    <div class="st-section-body">${body}</div>
  </section>`;
}

/**
 * A label, a line of supporting text, and the control that changes it.
 *
 * `row` is the search anchor. The row itself takes `tabindex="-1"` so a
 * search result can put focus on the row it named — landing on the label the
 * person searched for, rather than on whichever control happens to be first.
 */
export function settingRow({
  row,
  label,
  description = "",
  control = "",
  labelId,
  stacked = false,
  tone = "",
  media = "",
}) {
  const anchor = row === undefined ? "" : String(row);
  const id = anchor === "" ? "" : `settings-row-${anchor}`;
  const resolvedLabelId = labelId ?? (id === "" ? undefined : `${id}-label`);
  return `<div class="st-row${stacked ? " st-row-stacked" : ""}${
    tone === "" ? "" : ` st-row-${esc(tone)}`
  }"${id === "" ? "" : ` id="${esc(id)}" data-settings-row="${esc(anchor)}" tabindex="-1"`}>
    ${media === "" ? "" : `<div class="st-row-media">${media}</div>`}
    <div class="st-row-body">
      <div class="st-row-label"${
        resolvedLabelId === undefined ? "" : ` id="${esc(resolvedLabelId)}"`
      }>${esc(label)}</div>
      ${description === "" ? "" : `<p class="st-row-help">${description}</p>`}
    </div>
    ${control === "" ? "" : `<div class="st-row-control">${control}</div>`}
  </div>`;
}

/**
 * A labelled choice of three or fewer, as a radio group.
 *
 * `role="radiogroup"` rather than a row of pressed buttons: the choice is
 * one of a set, and a screen reader should say "2 of 3" rather than reading
 * three independent toggles.
 */
export function segmentedControl({ act, label, value, options }) {
  return `<div class="st-segmented" role="radiogroup" aria-label="${esc(label)}">
    ${options
      .map((option) => {
        const active = option.value === value;
        return `<button type="button" role="radio" aria-checked="${active}"
          class="st-segment${active ? " is-active" : ""}"
          data-act="${esc(act)}" data-value="${esc(option.value)}"
          tabindex="${active ? "0" : "-1"}">
          ${option.iconName === undefined ? "" : icon(option.iconName)}
          <span>${esc(option.label)}</span>
        </button>`;
      })
      .join("")}
  </div>`;
}

/** A two-state control that says what it is, and what state it is in. */
export function switchControl({ act, field, label, on, value, busy = false }) {
  return `<button type="button" role="switch" aria-checked="${on === true}"
    class="switch st-switch${on === true ? " on" : ""}"
    data-act="${esc(act)}"${field === undefined ? "" : ` data-field="${esc(field)}"`}${
      value === undefined ? "" : ` data-value="${esc(value)}"`
    }${busy ? ' aria-busy="true"' : ""}
    aria-label="${esc(label)}"></button>`;
}

/**
 * A state, said in a word and drawn in a colour.
 *
 * Both, always. A dot alone puts the whole meaning in a hue, which is unread
 * by anybody who cannot separate the hues — and unreadable in a screenshot.
 */
export function statusBadge(tone, label, options = {}) {
  const glyph = options.iconName;
  return `<span class="st-status st-status-${esc(tone)}"${
    options.title === undefined ? "" : ` title="${esc(options.title)}"`
  }>${glyph === undefined ? "" : icon(glyph)}<span>${esc(label)}</span></span>`;
}

/**
 * A provider — an agent vendor or an integration — as one complete row.
 *
 * Same shape whichever it is, because they are the same object to a reader:
 * a mark, a name, what it is for, whether it is connected, and the one
 * control that changes that.
 */
export function providerRow({
  row,
  mark = "",
  name,
  description = "",
  status,
  detail = "",
  controls = "",
  busy = false,
}) {
  const anchor = row === undefined ? "" : String(row);
  return `<div class="st-provider${busy ? " is-busy" : ""}"${
    anchor === ""
      ? ""
      : ` id="settings-row-${esc(anchor)}" data-settings-row="${esc(anchor)}" tabindex="-1"`
  }>
    <span class="st-provider-mark" aria-hidden="true">${mark}</span>
    <span class="st-provider-body">
      <span class="st-provider-name">${esc(name)}</span>
      ${description === "" ? "" : `<span class="st-provider-desc">${esc(description)}</span>`}
      <span class="st-provider-state">
        ${status ?? ""}${detail === "" ? "" : `<span class="st-provider-detail">${esc(detail)}</span>`}
      </span>
    </span>
    ${controls === "" ? "" : `<span class="st-provider-controls">${controls}</span>`}
  </div>`;
}

/** Placeholder rows with the shape of the answer that has not arrived yet. */
export function skeletonRows(count = 3) {
  return `<div class="st-skeleton" data-settings-skeleton aria-hidden="true">
    ${Array.from(
      { length: Math.max(1, count) },
      () => `<div class="st-skeleton-row">
        <span class="st-skeleton-bar st-skeleton-title"></span>
        <span class="st-skeleton-bar st-skeleton-sub"></span>
      </div>`,
    ).join("")}
  </div>`;
}

/** Nothing here, said as a fact rather than as a gap. */
export function emptyState({ iconName = "info", title, description = "", action = "" }) {
  return `<div class="st-empty" data-settings-empty>
    <span class="st-empty-mark">${icon(iconName)}</span>
    <div class="st-empty-copy">
      <div class="st-empty-title">${esc(title)}</div>
      ${description === "" ? "" : `<p>${esc(description)}</p>`}
    </div>
    ${action === "" ? "" : `<div class="st-empty-action">${action}</div>`}
  </div>`;
}

/** It did not work, what that means, and the one way to try again. */
export function errorState({
  title,
  description = "",
  retryAct = "",
  retryLabel = "Retry",
  retryValue = "",
}) {
  return `<div class="st-error" data-settings-error role="alert">
    <span class="st-error-mark">${icon("alert")}</span>
    <div class="st-error-copy">
      <div class="st-error-title">${esc(title)}</div>
      ${description === "" ? "" : `<p>${esc(description)}</p>`}
    </div>
    ${
      retryAct === ""
        ? ""
        : `<button type="button" class="btn btn-sm" data-act="${esc(retryAct)}"${
            retryValue === "" ? "" : ` data-value="${esc(retryValue)}"`
          }>${esc(retryLabel)}</button>`
    }
  </div>`;
}

/**
 * The bar that appears when a form has unsaved changes, and only then.
 *
 * The alternative — a Save button that is always on screen — asks the reader
 * to work out whether pressing it would do anything. This says so.
 */
export function dirtySaveBar({
  message = "You have unsaved changes",
  saveAct,
  discardAct,
  saveLabel = "Save changes",
  discardLabel = "Discard",
  saving = false,
}) {
  return `<div class="st-dirty" data-settings-dirty role="status" aria-live="polite">
    <span class="st-dirty-copy">${esc(message)}</span>
    <span class="st-dirty-actions">
      <button type="button" class="btn btn-sm" data-act="${esc(discardAct)}"${
        saving ? " disabled" : ""
      }>${esc(discardLabel)}</button>
      <button type="button" class="btn btn-sm btn-primary" data-act="${esc(saveAct)}"${
        saving ? ' disabled aria-busy="true"' : ""
      }>${esc(saving ? "Saving…" : saveLabel)}</button>
    </span>
  </div>`;
}

/** Facts nobody can edit here, as the term/description pairs they are. */
export function definitionList(items) {
  return `<dl class="st-deflist">
    ${items
      .map(
        (item) => `<div class="st-deflist-row">
          <dt>${esc(item.term)}</dt>
          <dd${item.mono === true ? ' class="st-deflist-mono"' : ""}>${esc(
            item.value,
          )}</dd>
        </div>`,
      )
      .join("")}
  </dl>`;
}

/** One search result: where it lives, then what it is called. */
export function settingsSearchResultRows(results, activeIndex = 0) {
  return results
    .map(
      (result, index) => `<li role="presentation">
        <button type="button" role="option" id="settings-search-option-${String(index)}"
          class="st-result${index === activeIndex ? " is-active" : ""}"
          aria-selected="${index === activeIndex}"
          data-act="settings-search-go" data-value="${esc(result.section)}"
          data-row="${esc(result.row)}">
          <span class="st-result-path">${esc(result.sectionLabel)} › ${esc(
            result.group,
          )}</span>
          <span class="st-result-name">${esc(result.label)}</span>
        </button>
      </li>`,
    )
    .join("");
}

/**
 * The search field, and the results under it when there is a query.
 *
 * A combobox rather than a filter: the list is a set of destinations, Enter
 * goes to one, and the arrow keys move between them without leaving the
 * field. It is also the first thing focus lands on when the dialog opens,
 * which is what makes typing the fastest way to anywhere in here.
 */
export function settingsSearch({ query = "", results = [], activeIndex = 0 }) {
  const open = query.trim().length > 0;
  const hasResults = results.length > 0;
  return `<div class="st-search" data-settings-search>
    <div class="st-search-field" role="combobox" aria-expanded="${open}"
      aria-haspopup="listbox" aria-owns="settings-search-results">
      <span class="st-search-mark" aria-hidden="true">${icon("search")}</span>
      <input class="st-search-input" type="search" data-act="settings-search-input"
        value="${esc(query)}" placeholder="Search settings"
        aria-label="Search settings" aria-controls="settings-search-results"
        aria-autocomplete="list" autocomplete="off" spellcheck="false"
        ${
          open && hasResults
            ? `aria-activedescendant="settings-search-option-${String(activeIndex)}"`
            : ""
        }>
      ${
        query === ""
          ? ""
          : `<button type="button" class="st-search-clear" data-act="settings-search-clear"
              aria-label="Clear search">${icon("close")}</button>`
      }
    </div>
    ${
      !open
        ? `<ul class="st-results" id="settings-search-results" role="listbox"
             aria-label="Settings search results" hidden></ul>`
        : hasResults
          ? `<ul class="st-results" id="settings-search-results" role="listbox"
               aria-label="Settings search results">
               ${settingsSearchResultRows(results, activeIndex)}
             </ul>`
          : `<ul class="st-results" id="settings-search-results" role="listbox"
               aria-label="Settings search results">
               <li class="st-results-empty" role="option" aria-selected="false"
                 aria-disabled="true">No settings match “${esc(query)}”</li>
             </ul>`
    }
    <p class="sr-only" role="status" aria-live="polite">${
      !open
        ? ""
        : hasResults
          ? `${String(results.length)} setting${results.length === 1 ? "" : "s"} found`
          : "No settings found"
    }</p>
  </div>`;
}

/** One category in the sidebar. */
function sidebarItem(item, selected) {
  const active = item.id === selected;
  return `<button type="button" class="st-nav-item${active ? " is-active" : ""}"
    data-act="settings-section" data-value="${esc(item.id)}"
    aria-current="${active ? "page" : "false"}">
    ${icon(item.iconName)}<span>${esc(item.label)}</span></button>`;
}

/**
 * The whole sidebar: two headings and the categories under them, with any
 * category the groups forget still drawn at the foot. A category that exists
 * and cannot be reached is the worse failure.
 */
export function settingsSidebar({ sections, selected }) {
  const grouped = new Set(SETTINGS_GROUPS.flatMap((group) => group.sections));
  const groups = SETTINGS_GROUPS.map((group) => {
    const items = sections.filter((section) =>
      group.sections.includes(section.id),
    );
    if (items.length === 0) {
      return "";
    }
    const id = `settings-group-${esc(group.id)}`;
    return `<div class="st-nav-group" role="group" aria-labelledby="${id}">
      <div class="st-nav-label" id="${id}">${esc(group.label)}</div>
      ${items.map((item) => sidebarItem(item, selected)).join("")}
    </div>`;
  }).join("");
  const rest = sections.filter((section) => !grouped.has(section.id));
  return `<nav class="st-nav" aria-label="Settings categories">
    ${groups}${
      rest.length === 0
        ? ""
        : `<div class="st-nav-group">${rest
            .map((item) => sidebarItem(item, selected))
            .join("")}</div>`
    }
  </nav>`;
}

/**
 * The phone's replacement for the sidebar.
 *
 * A native `<select>`, not a row of chips that scrolls sideways: it is a
 * choice of one from a short list, the platform already knows how to present
 * that on a small screen, and it costs no horizontal room at 390px.
 */
export function settingsMobileCombobox({ sections, selected }) {
  const grouped = SETTINGS_GROUPS.map((group) => {
    const items = sections.filter((section) =>
      group.sections.includes(section.id),
    );
    if (items.length === 0) {
      return "";
    }
    return `<optgroup label="${esc(group.label)}">
      ${items
        .map(
          (item) => `<option value="${esc(item.id)}"${
            item.id === selected ? " selected" : ""
          }>${esc(item.label)}</option>`,
        )
        .join("")}
    </optgroup>`;
  }).join("");
  return `<div class="st-mobile-nav">
    <label class="sr-only" for="settings-category">Settings category</label>
    <select class="st-mobile-select" id="settings-category"
      data-act="settings-section-select">${grouped}</select>
    <span class="st-mobile-caret" aria-hidden="true">${icon("chevronDown")}</span>
  </div>`;
}
