# Phase 1: Persistence

## Why this first

Phase 1 calls for a web dashboard, authentication, repository import, task
management, diff review, agent status, and integration history. Six of those
seven need state that outlives a single process. Phase 0 kept everything in
memory: a run's tasks, leases, changesets, and audit events existed only while
the CLI was alive, so a crash lost the record of work that had already touched
the canonical repository.

The store is therefore the foundation, not the first feature. It directly
supplies task management, integration history, agent status, and the audit
timeline; the dashboard becomes a read model over it rather than a live view of
one process.

## Backend

`node:sqlite`, built into Node 24. This adds durable state with no runtime
dependency and no database server, which keeps the local proof runnable on a
machine with nothing installed but Node and Git. It raises the engine floor
from Node 22 to Node 24, since `node:sqlite` is flagged before then.

`CoordinationStore` is an interface with two implementations. A shared contract
test runs against both, so the in-memory default cannot silently drift from the
durable one. `§9` of `instructions.md` names PostgreSQL for the platform build;
the async interface over a synchronous driver exists so that swap needs no
caller changes.

## What is recorded

Writes happen as a run progresses rather than at the end, so a crash leaves a
partial but truthful record instead of nothing:

- `runs` — mode, scenario, base and final revision, status
- `tasks` — objective, agent, plan, coordinator decision, session, final status
- `conflicts` — scored pairs with their file-overlap evidence
- `resource_leases` — grants and release times
- `workspaces` — path, isolation mode, base revision
- `changesets` and `file_patches` — full patch text, so diff review needs no
  surviving worktree
- `integrations` — status, validation output, and **both** canonical versions
- `canonical_versions` — every revision the coordinator has observed
- `audit_events` — append-only, hash-chained

Integration records store the previous version's branch and timestamp in full.
Deriving them from the canonical version silently misreports the base a
changeset was attempted against, which is exactly the fact an integration
history exists to answer.

## Audit integrity

`§17` requires immutable audit records and `§8.10` a tamper-evident history.
Two mechanisms, doing different jobs:

1. **Append-only enforcement.** SQLite triggers abort any `UPDATE` or `DELETE`
   on `audit_events`, so an in-place edit fails loudly.
2. **Hash chain.** Each event stores a payload hash and a chain hash folding in
   its predecessor. Editing, removing, reordering, or inserting an event breaks
   the chain from that point on.

The triggers stop casual edits. They do not stop someone who can write the
database file from dropping a trigger and rebuilding the table — the chain is
what makes that detectable, and `coord verify-audit` reports the first event
where the history stops being consistent.

This is detection, not prevention. An attacker with write access can recompute
the whole chain. Making that impossible needs an external anchor — a signed or
replicated checkpoint — which is deferred.

Payload hashing serializes with sorted keys so an event always hashes to the
same digest regardless of field insertion order.

## Coordinator integration

The store is optional. `Coordinator` takes one and writes through at every
transition it already recorded in the audit log; with no store, behavior is
byte-for-byte what it was in Phase 0. That keeps the deterministic benchmark
path free of I/O and makes persistence a decision at the call site.

## Not yet built

- HTTP surface and web dashboard over the store
- Authentication and multi-tenancy; `organizations`, `users`, `principals`,
  `projects`, and `policies` from `§19` have no code behind them yet
- Crash recovery: the store now records enough to resume, but nothing reads it
  back to resume a partial run, and worktrees are still not garbage collected
  across restarts
- Retention: the audit log grows without bound
- External anchoring of the audit chain
