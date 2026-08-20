/**
 * What a cold start waits for, and what it does not.
 *
 * Opening the app used to mean five round trips stacked end to end — health,
 * then the session, then the organizations, then that organization's projects,
 * then nine project calls — and fourteen requests before anything could be
 * drawn. On a phone, where a round trip is a large fraction of the wait, the
 * stacking mattered more than the payloads did.
 *
 * The two tables below are that waterfall written down instead of implied by
 * the order of statements. Everything in the first table is something a screen
 * cannot be drawn without; everything in the second is something a screen can
 * fill in a moment later without looking broken. Keeping them as data is what
 * lets a test count the first paint's cost, which is the only way a regression
 * here gets noticed by anyone but the person holding the phone.
 *
 * This module deliberately touches no browser API: it is pure data, so it can
 * be read directly by a test as well as by the dashboard.
 */

/**
 * One project-scoped load: where it comes from, where it lands, and what it
 * reads as before it arrives.
 *
 * `optional` marks a deployment capability rather than a fact — metrics, the
 * worker fleet and the agent roster answer 501 or 403 on a control plane that
 * does not offer them, and that must not blank a screen.
 */

/** Loads the first paint genuinely cannot happen without. */
export const FIRST_PAINT_PROJECT_LOADS = [
  {
    key: "repositories",
    path: (project) => `/projects/${project}/repositories`,
    field: "repositories",
    empty: [],
    optional: false,
  },
  {
    key: "tasks",
    path: (project) => `/projects/${project}/tasks`,
    field: "tasks",
    empty: [],
    optional: false,
  },
  {
    key: "approvals",
    path: (project) => `/projects/${project}/approvals`,
    field: "approvals",
    empty: [],
    optional: false,
  },
  {
    key: "project",
    path: (project) => `/projects/${project}`,
    field: "project",
    empty: undefined,
    optional: false,
  },
  {
    key: "agents",
    path: (project) => `/projects/${project}/agents`,
    field: "agents",
    empty: [],
    optional: true,
  },
];

/**
 * Loads that arrive after the screen does.
 *
 * None of these is on a chat screen's critical path: the run history and the
 * audit feed are read on their own screens, the metrics tile and the worker
 * fleet are settings-side. Each one was a request the first paint waited for
 * and a payload it paid for — the run history alone asks for a hundred rows.
 */
export const DEFERRED_PROJECT_LOADS = [
  {
    key: "runs",
    path: (project) => `/projects/${project}/runs?limit=100`,
    field: "runs",
    empty: [],
    optional: false,
  },
  {
    key: "audit",
    path: (project) => `/projects/${project}/audit`,
    field: "events",
    empty: [],
    optional: false,
  },
  {
    key: "metrics",
    path: (project) => `/projects/${project}/metrics`,
    field: "metrics",
    empty: undefined,
    optional: true,
  },
  {
    key: "workers",
    path: (project, organization) => `/workers?organizationId=${organization}`,
    field: "workers",
    empty: [],
    optional: true,
  },
];

/**
 * How many serial round trips a cold start costs before it can draw.
 *
 * One: health and the session and the organization list, which depend on
 * nothing but the cookie. Two: the chosen organization's projects and members.
 * Three: the chosen project's first-paint loads. Nothing inside a step waits
 * on anything else inside it.
 */
export const FIRST_PAINT_ROUND_TRIPS = 3;
