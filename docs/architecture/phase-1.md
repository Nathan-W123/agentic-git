# Phase 1: Local MVP

## Outcome

The Phase 1 local MVP is complete. It adds a durable multi-tenant control
plane and responsive web dashboard over the technical proof.

## Persistence

`CoordinationStore` has in-memory and SQLite implementations with one shared
contract test suite. SQLite uses Node 24's built-in `node:sqlite`, keeping the
local deployment dependency-free.

State is written during a run, not reconstructed at the end:

- organizations, users, memberships, projects, and project repositories,
- authentication sessions and durable approval requests,
- submitted tasks and run/task status,
- plans and every plan revision,
- conflicts and transparent evidence,
- resource leases and workspaces,
- scope requests and decisions,
- changesets and ordered file patches,
- validation and integration outcomes,
- canonical versions and hash-chained audit events.

Task claiming is transactional and project-scoped. A crash cannot cause a
different project to consume the task or silently execute the same queue entry
twice. Failed or stranded entries can be retried explicitly.

## Audit Integrity

SQLite triggers reject updates and deletes on audit events. Every event also
stores a payload hash and chain hash, so editing, removal, insertion, or
reordering is detectable with `coord verify-audit`.

This is tamper evidence, not an external trust anchor. An attacker who controls
the database file and all verification code could rebuild the chain; signed or
replicated checkpoints remain a later deployment feature.

## API And Authentication

The versioned `/api/v1` surface includes:

- one-time owner bootstrap and password login,
- HTTP-only session cookies and double-submit CSRF protection,
- organization/project RBAC and tenant isolation,
- rate limits, body limits, origin checks, CSP and browser hardening headers,
- organizations, projects, repositories, tasks, runs, approvals, members, and
  admin operations,
- project-scoped authenticated WebSocket audit updates.

Unhashed web assets use ETag revalidation so a deployment cannot leave a
browser running stale JavaScript against a new API.

## Web Product

The control room provides:

- setup and sign-in,
- overview metrics and a live project ledger,
- task submission, cancellation, retry, and run controls,
- run details with plans, replans, scope, conflicts, diffs, validation, and
  integration history,
- human approval review and decisions,
- GitHub import,
- team membership and roles,
- project, organization, and system administration.

The interface is responsive on desktop and mobile. A browser audit exercised
every route, authenticated session behavior, mobile navigation, and horizontal
overflow with no application exceptions.

## Operational Boundary

This phase is a local, single-process control plane. Durable state supports
manual recovery, but automatic in-place run resumption, worktree scavenging,
PostgreSQL/Redis, high availability, and distributed workers remain later
deployment phases. See [current-state.md](current-state.md).
