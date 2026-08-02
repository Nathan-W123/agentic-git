# Current Capability Matrix

This document maps the repository to `instructions.md`. It distinguishes
implemented behavior from later product phases so missing work is explicit.

`instructions.md` describes a multi-developer, multi-device platform. What is
implemented today uses one active control-plane process with remote worker
execution over HTTP and either SQLite or PostgreSQL coordination state.
Workers can run on other devices; canonical Git storage and integration remain
on the control-plane host. High availability and shared canonical object
storage remain later phases.

## Required MVP

| Requirement | Status | Evidence |
| --- | --- | --- |
| GitHub repository import | Implemented | HTTPS/SSH normalization, optional token injection through Git environment, rollback on failed imports |
| At least two coding-agent adapters | Implemented and exceeded | Generic JSONL, Codex, Claude, and Gemini adapters |
| Task submission | Implemented | Durable project queue through CLI and API/web |
| Agent plan submission | Implemented | Validated plans are required before workspace execution |
| File-level ownership | Implemented | Expiring resource leases and scheduling decisions |
| Isolated Docker workspaces | Implemented and runtime verified | Live verification confirms deny-default network, workspace-only writes, masked Git metadata, read-only root, and successful containerized coordination |
| Live task status | Implemented | Durable state plus project-scoped WebSocket audit updates |
| Diff collection | Implemented | Host-collected structured patches retained in the configured coordination store |
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
- Execution history and detail views for plans, conflicts, plan revisions, scope
  decisions, patches, validation, integrations, and audit events.
- Approval queue, reasons, diff review, approve/reject decisions, and durable
  reviewer comments.
- Greenfield repository creation, credential-safe GitHub import, and
  repository status.
- Team membership, role controls, project and organization settings, user
  creation, account disabling, and system-admin controls.
- Responsive desktop/mobile layout and project-scoped WebSocket refreshes.
- Board, canonical history, pipeline-safe rollback, registered-worker fleet,
  coordination metrics, and diff-anchored review comments.
- Per-user Git overlay workspaces with Monaco editing, bounded one-shot
  commands inside the configured Docker sandbox, and pipeline submission.

The web product is still a control room rather than a collaborative IDE.
Presence, shared cursors, PTY terminal streams, and projection of agents'
unapproved in-flight edits remain later surfaces.

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

One lever now acts before any of that. Intake can divide a submitted objective
into several narrower, non-overlapping tasks *before* an agent plans it, so
conflicts that would have been detected are instead never created. The
footprint is estimated deterministically from the objective text against the
canonical index, and the split is refused unless the estimate is anchored, the
wording carries no atomicity signal, the candidate pieces are structurally
uncoupled, and — in the default mode — the division actually frees some piece
from work already in flight. It is prevention layered over detection, not a
replacement for it, and it is verified statically only: whether it reduces real
conflicts is an open question with a live experiment still to run. See
docs/architecture/task-decomposition.md.

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
6. Generic, Codex, Claude, and Gemini adapters support replanning. The generic
   protocol also carries pause, resume, cancel, and scope-decision messages.

Plan revisions, scope requests, decisions, approvals, and canonical-change
evidence survive process and browser restarts in the coordination store.

## Repository Lifecycle

- Greenfield start: `coord repo create` and the web repository form create an
  empty canonical repository with an initial commit. Importing a path that is
  not yet a repository, or one with no commits, also initializes it; any files
  already present become that commit. A repository that already has history
  is never modified, and a missing branch there is still an error rather than
  an invented commit.
- Import records the upstream tip as `refs/coord/imported/<branch>` inside the
  canonical mirror, so the mirror itself knows what it diverged from.
- Export publishes canonical state with `coord repo push`. It targets a
  dedicated `coord/export-*` branch rather than the imported branch, never
  force-pushes, and refuses outright when the remote has moved since import.
  Credentials come from `GITHUB_TOKEN` and are passed only as a request header
  in the child environment.

## Remote Execution

Hosted execution has a protocol and a working control-plane half:

- API tokens with scopes bounded by the holder's role, hashed at rest, usable
  by headless clients without cookies or CSRF.
- A worker protocol with exclusive expiring leases, heartbeats, release, and
  requeue on expiry, so a worker that dies cannot strand a task.
- Workspace materialization by Git bundle, so a worker receives one advertised
  lease ref plus the ancestors Git needs to materialize it, but no newer
  canonical tip or unrelated branch ref.
- A worker daemon that leases, clones, runs an agent, and returns a changeset,
  honoring the project container sandbox when one is configured.
- Plan-first admission (protocol version 2): the worker's agent plans, the
  plan is arbitrated against every plan currently executing in the repository
  using the same conflict detection and ownership services the local scheduler
  uses, and only an approved answer licenses execution. A conflict costs one
  planning round trip instead of a discarded execution. Arbitration is
  serialized in the store, so concurrent workers cannot both be admitted
  against a stale view. Exact-base integration and requeue-to-replan remain
  the backstop underneath. See docs/protocol/remote-workers.md.
- An optional human gate at admission time (`requireRemotePlanReview`), so a
  risky *plan* stops for a reviewer before the agent runs rather than after.
  The reasons are the ones the local scheduler already stops on, the approval
  record is the same durable one, and the worker waits on a separate,
  much longer budget because waiting for a person is not waiting for a lease.
- Mid-execution scope arbitration. A remote agent that needs a file outside
  its admitted plan is answered rather than refused: the widened plan goes
  through the same admission machinery against every other active lease and
  comes back granted, deferred (with the holders named and a retry interval),
  or refused with a reason. A grant replaces the admitted contract before the
  edits arrive, so result enforcement is unchanged.
- Token cost accounting and caps. Agents that report their spend have it
  recorded per task and per project; `maxTaskTokens` is enforced at heartbeat,
  while the spending is still happening, and `maxProjectTokensPerDay` throttles
  leasing the way the runtime budget does. Reporting is optional and never
  inferred, so an agent that says nothing is recorded as having said nothing.

Container isolation for hosted execution is verified against a live Docker
daemon, not merely implemented: `npm run verify:remote-docker` drives the whole
protocol end to end with the agent in a container, and the agent probes its own
confinement from inside and reports the verdicts with its changeset.

Phase 2's coordination surfaces are reachable from the control room, not only
from the API and CLI: a Coordination route showing prediction quality, rework,
and remote-execution cost against their denominators; the declarative project
policy and both runtime budgets as an editable form; the registered worker
fleet; a Board projecting the task queue by status; canonical version history
per repository; and review comment threads anchored to changeset diffs.

Two operational gaps closed with them. The audit log can be **compacted**:
`archiveAuditEvents` moves an unbroken prefix into an archive table behind a
checkpoint recording the chain hash and a digest of the segment, so
verification spans archived and live events and still detects tampering in
either. The delete trigger became conditional on a checkpoint rather than
absolute, so history still cannot be dropped quietly. And **rollback** exists:
reverting canonical to an earlier revision is submitted as an ordinary change —
planned, conflict-checked against executing work, validated, policy-gated, and
promoted by compare-and-swap — never a raw `git reset`, so history moves
forward and the reverted revision stays reachable.

The coordination store itself is no longer bound to one disk: alongside the
SQLite file, a PostgreSQL backend implements the same store contract and is
selected by setting `COORD_DATABASE_URL` to a `postgresql://` URL. Both
backends are validated by one parameterized contract suite; the Postgres tests
run against a real dockerized server when Docker is available. Agent execution
can be remote, while the control plane, canonical repositories, and integration
still share one host even when state lives in a shared database.

## Later Phases

The following are intentionally not represented as complete:

- In-place resumption of a half-finished *agent session*. This is an
  architectural limit rather than a to-do: agents are stateless child
  processes whose reasoning lives in their own memory and whose edits live in
  a workspace the crash orphaned, so nothing durable describes where one had
  got to. A task killed while its agent was thinking genuinely has to run
  again.

  The pipeline behind the agent does now resume. A changeset is written to the
  store the moment it is collected, before anything is validated or promoted,
  so a crash in that window leaves a complete durable description of finished
  work. On boot (and via `coord recover`) the control plane integrates it —
  three-way apply, declared-versus-applied comparison, validation under the
  project's sandbox, compare-and-swap promotion, exactly as the normal path —
  instead of failing the task and paying for the agent run a second time.
  Recovery still fails what it cannot resume, requeues claimed tasks whose
  process died (live remote leases are left untouched), clears orphaned
  workspace/planning/integration worktrees, and prunes their registrations
  from the canonical mirrors. `coord recover` reports resumed tasks alongside
  failed runs.
- Redis/event-bus deployment, high availability, Kubernetes, Terraform,
  hybrid workers, and air-gapped release tooling. (A PostgreSQL storage
  backend exists; the rest of that deployment stack does not.)
- Dependency/malware scanning, signed artifacts, external audit anchoring,
  SSO, and billing. (Declarative per-project policy governs approvals,
  runtime budgets, and token budgets — see docs/deployment.md. Token counts
  are accounted and capped; per-model pricing, invoicing, and payment
  plumbing do not exist.)
- Container isolation for the vendor CLIs. Codex, Claude Code, and Gemini CLI
  run on the host under their own sandboxing, because the container denies
  egress by default and a vendor CLI cannot reach its provider's API without
  it, and because their credentials are host login state the container
  deliberately cannot see. The dependency is a per-task egress allowlist, not
  adapter work; docs/protocol/remote-workers.md records the evidence.
- Validation executed by the worker rather than by the control-plane host.
  With a sandbox configured it already runs in a container rather than as the
  control-plane process, but the tree being validated is the merge of a result
  onto current canonical, which exists only on the control plane.
- Collaborative IDE presence/cursors, PTY terminal streams, and projection of
  agents' unapproved in-flight edits. Per-user human overlay editing and
  bounded sandbox commands are already implemented.
- Broad language-server coverage, cross-repository planning, learned
  scheduling, and automatic semantic conflict resolution.
- Continuous external Git synchronization, release/tag management, pull-request
  creation, and complete GitHub replacement behavior. One-way export exists;
  fetching upstream changes back into canonical does not.

These items belong to Phases 2-4 in `instructions.md`; they are not required to
operate or verify the coordinator as implemented.
