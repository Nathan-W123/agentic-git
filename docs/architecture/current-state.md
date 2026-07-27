# Current Capability Matrix

This document maps the repository to `INSTRUCTIONS.md`. It distinguishes
implemented local-platform behavior from later product phases so missing work
is explicit.

## Required MVP

| Requirement | Status | Evidence |
| --- | --- | --- |
| GitHub repository import | Implemented | HTTPS/SSH normalization, optional token injection through Git environment, rollback on failed imports |
| Two coding-agent adapters | Implemented | Generic JSONL adapter and native Codex adapter |
| Task submission | Implemented | Durable project queue through CLI and API/web |
| Agent plan submission | Implemented | Validated plans are required before workspace execution |
| File-level ownership | Implemented | Expiring resource leases and scheduling decisions |
| Isolated Docker workspaces | Implemented, runtime proof pending | Deny-default network, read-only root, dropped capabilities, CPU, memory, PID, and timeout controls; live daemon unavailable in the latest audit |
| Live task status | Implemented | Durable state plus project-scoped WebSocket audit updates |
| Diff collection | Implemented | Host-collected structured patches retained in SQLite |
| Automated tests | Implemented | Validation commands run in temporary integration snapshots |
| Sequential atomic integration | Implemented | Git three-way application and compare-and-swap canonical promotion |
| Git commit creation | Implemented | Every promoted changeset creates a canonical checkpoint |
| Basic conflict warnings | Implemented and exceeded | Structural and advisory intent evidence with explanations |
| Human approval | Implemented | Durable plan, scope, and changeset gates with approve, reject, cancel, and expiry |
| Audit timeline | Implemented | Append-only, hash-chained events scoped by tenant, project, and run |

## Product Surfaces

The local Phase 1 product surface is complete:

- One-time owner setup, login/logout, HTTP-only sessions, CSRF protection, and
  password hashing.
- Organization and project selection with owner, admin, developer, reviewer,
  and viewer RBAC.
- Task submission, queue filtering, cancellation, retry, repository runs, and
  live status.
- Run history and detail views for plans, conflicts, plan revisions, scope
  decisions, patches, validation, integrations, and audit events.
- Approval queue, reasons, diff review, approve/reject decisions, and durable
  reviewer comments.
- Credential-safe GitHub import and repository status.
- Team membership, role controls, project and organization settings, user
  creation, account disabling, and system-admin controls.
- Responsive desktop/mobile layout and project-scoped WebSocket refreshes.

The web product is a control room, not a full browser IDE. Presence, cursors,
terminals, Monaco editing, and unapproved overlay projection remain later
surfaces, consistent with the MVP non-goals.

## Deeper Coordination

The coordinator implements all four conflict levels:

- File evidence detects planned path overlap.
- Symbol and structural evidence covers symbols, APIs, schemas,
  configuration keys, tests, and services.
- Dependency evidence detects producer/consumer relationships across files and
  creates directed scheduling edges.
- Intent evidence is deterministic and advisory; it never silently blocks
  work.

Scores, evidence, explanations, and dispositions are deterministic.
Thresholds and weights are constructor-configurable. Ownership modes include
observe, shared, intent, exclusive, and approval-required. The scheduler runs
independent work in parallel, sequences structural dependencies, rejects
cycles, and recursively cancels consumers whose required producer fails.

Code intelligence uses the TypeScript compiler API for TypeScript/JavaScript
and deterministic parsers for JSON, YAML, SQL, and Prisma. Indexing is bounded
by file count and byte limits and cached by repository revision.

## Dynamic Replanning

Dynamic replanning is implemented end to end:

1. Each task records its initial validated plan as revision 1.
2. After a blocker promotes canonical, the coordinator indexes both canonical
   revisions and derives changed files, symbols, APIs, schemas, configuration
   keys, tests, and services.
3. The adapter receives `replan_request` with the prior plan, canonical change
   notice, constraints, and a fresh disposable planning worktree.
4. The replacement plan is validated, rescored, persisted as a new revision,
   and used for ownership and execution against the latest canonical version.
5. During execution, a structured scope request is checked against active
   work. Conflict-free resources receive new leases; protected scope waits for
   human approval; conflicting scope is rejected with evidence.
6. Generic and Codex adapters support replanning. The generic protocol also
   carries pause, resume, cancel, and scope-decision messages.

Plan revisions, scope requests, decisions, approvals, and canonical-change
evidence survive process and browser restarts in the coordination store.

## Later Phases

The following are intentionally not represented as complete:

- Automatic in-place crash resumption and cross-restart worktree garbage
  collection. State is preserved and tasks can be retried manually.
- PostgreSQL/Redis/event-bus deployment, high availability, Kubernetes,
  Terraform, hybrid workers, and air-gapped release tooling.
- General declarative policy evaluation, dependency/malware scanning, signed
  artifacts, external audit anchoring, SSO, billing, and cost accounting.
- Full IDE, presence/cursor/terminal streams, and projection of unapproved task
  overlays.
- Broad language-server coverage, cross-repository planning, learned
  scheduling, and automatic semantic conflict resolution.
- External Git synchronization, release/tag management, and complete GitHub
  replacement behavior.

These items belong to Phases 2-4 in `INSTRUCTIONS.md`; they are not required to
operate or verify the implemented local coordinator.
