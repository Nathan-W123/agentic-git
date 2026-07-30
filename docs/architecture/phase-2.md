# Phase 2: Private Beta

## Outcome

Phase 2 adds the things a team other than its authors needs before it will put
real work through the coordinator: coordination that reasons about symbols
rather than files, a policy engine an operator can configure, workers on other
machines, cost controls, richer audit, and recovery that does not throw away
finished work.

Most of that was already in place. This document records the state of the
remaining items honestly — including the two that turned out to be
architectural limits rather than unfinished work.

## Symbol-level coordination

Complete. All four conflict levels are implemented and deterministic — file,
symbol/structural, dependency, and advisory intent — with the TypeScript
compiler API behind TypeScript and JavaScript and deterministic parsers for
JSON, YAML, SQL, and Prisma. See [coordination](coordination.md).

Partial admission acts at the same granularity: a plan colliding on one file
of five is admitted on the other four, and where the index can locate a symbol
precisely enough to check a patch against it, a *symbol* can be withheld while
the file holding it is granted.

## Policy engine

Complete. A declarative per-project policy governs approvals and budgets:
which risk levels stop for a human, whether schemas and changesets always do,
which paths are protected, how long an approval waits, and four spending
limits. It is editable from the dashboard and validated on write.

Two approval gates were added this phase. `requireRemotePlanReview` moves the
remote gate from the changeset to the plan, so a risky plan stops a worker
before its agent runs rather than after. And a mid-execution scope expansion
is subject to the same policy: an expansion touching a schema or a protected
path waits for a reviewer while the agent holds.

## Customer-hosted workers

Complete and **verified live**. The remote protocol was already implemented
and unit-tested; what was missing was evidence that container isolation — the
whole reason hosted execution is defensible — works against a real Docker
daemon.

`npm run verify:remote-docker` supplies it. A real control plane binds a port,
a real worker daemon leases a task, downloads a Git bundle, clones it, runs the
reference agent **inside a container**, and posts a changeset the control plane
validates and promotes. Isolation is asserted from inside the container rather
than from the flags the host passed: the agent probes its own surroundings and
reports the verdicts in its completion explanation, which travels with the
changeset and is persisted.

```
[PASS] the worker plans, is admitted, and executes inside a container
[PASS] the containerized agent reported denied network, read-only root, and
       masked git - rootfs=readonly git=masked network=denied
[PASS] the repository's own tests ran in a container, not as the control plane
[PASS] canonical holds the containerized agent's edit
```

Building it turned up two real defects, both fixed: the reference agent
hard-coded a task id, which no remotely-minted task can ever match, and the
first container off a freshly built image can take longer to start than an
agent's planning timeout allows — which presented as an agent that never
answered rather than as the cold start it was.

### What is still not containerized, and why

Only generic-CLI agents get Docker confinement. The vendor CLIs — Codex,
Claude Code, Gemini CLI — run on the worker host under their own sandboxing,
and the worker refuses to combine them with a container rather than running
unconfined while appearing sandboxed.

That refusal now has a precise reason rather than a shrug. The container
denies egress by default, and a vendor CLI with no route to its provider's API
cannot do anything at all; their credentials are the CLI's own login state in
the host home directory, which the container deliberately cannot see; and
Codex's own `--sandbox` needs a platform backend that a `--cap-drop ALL`
container is a poor host for. The wiring is the easy part — all three adapters
funnel every invocation through one injectable process runner. The dependency
is the per-task egress allowlist, which is not built.
[remote-workers](../protocol/remote-workers.md) records the evidence.

### Where validation runs

With a sandbox configured, a repository's own test and build commands run in a
container with a read-only root, no network, and only the candidate worktree
mounted — not as the control-plane process. The live verification covers this,
running the repository's tests over the candidate tree inside the reference
image.

Validation still runs on the control-plane *host* rather than on a worker, and
that is a limit rather than a gap. The tree being validated is the three-way
merge of a result onto current canonical, which exists nowhere else. Shipping
it to a worker would mean handing that worker canonical content it is
specifically denied, and then trusting its self-reported pass — a weaker
guarantee than running it under confinement here, not a stronger one.

## Cost controls

Complete for tokens. Runtime budgets already existed; token accounting did not
beyond one experiment's ad-hoc capture.

Agents report their own spend — the Codex adapter parses the figure its CLI
prints, and a generic-CLI agent may attach a token count to its `done` message
— and the worker sends the running total up with each heartbeat and the final
figure with its result. Reports carry cumulative per-phase totals and the store
keys on `(lease, phase)` and replaces, so the recorded bill tracks what was
spent rather than how often the worker heartbeated.

`maxTaskTokens` is enforced at heartbeat, while the spending is still
happening; enforcing it at the result would only ever be a post-mortem.
`maxProjectTokensPerDay` throttles leasing exactly as the runtime budget does:
an exhausted project stops receiving workers, and tasks stay queued rather than
failing.

Reporting is optional and never inferred. An agent that says nothing is
recorded as having said nothing, because a budget enforced against an invented
figure would be worse than one enforced against a visible gap.

Per-model pricing, invoicing, and payment plumbing remain out of scope.

## Better audit logs

Complete. Append-only hash-chained events scoped by tenant, project, and run;
compaction behind a checkpoint that keeps verification spanning the archive;
and a delete trigger that is conditional on a checkpoint rather than absolute,
so history cannot be dropped quietly.

## Canonical history, rollback, review threads, board

Complete, and reachable from the dashboard rather than only from the API:
canonical version history per repository, pipeline-safe rollback submitted as
an ordinary planned and validated change, review comment threads anchored to
changeset diffs, and a board projecting the task queue by status.

## Reliability and recovery

Crash recovery is no longer purely restart-shaped.

An agent session cannot be resumed, and that is a property of the agent
contract rather than a missing feature: agents are stateless child processes
whose reasoning lives in their own memory and whose edits live in a workspace
the crash orphaned. Nothing durable describes where one had got to.

The pipeline behind the agent does resume. A changeset is written to the store
the moment it is collected — before validation, before promotion — so a crash
in that window leaves a complete, durable description of finished work. On boot
and via `coord recover`, that changeset is integrated rather than discarded:
applied three-way onto current canonical, compared against its declaration,
validated under the project's sandbox, and promoted by compare-and-swap, all
exactly as the normal path does. A task whose agent had finished is carried the
rest of the way instead of being failed and planned again from nothing.

Everything else recovery already did is unchanged: stranded runs fail, claimed
tasks whose process died requeue, live remote leases are left alone because
their leases are their liveness signal, and orphaned worktrees are cleared and
pruned. It remains idempotent — a resumed changeset has an integration record
afterwards, so a second pass finds nothing to redo.

## Success condition

Phase 2's success condition is measurable reductions in integration work for
real teams, which is a claim about usage and not about code. The
instrumentation for it exists — prediction quality, rework, and remote
execution cost against their denominators, on the Coordination route — and
[live evidence](../benchmarks/live-evidence.md) records what has actually been
measured so far.
