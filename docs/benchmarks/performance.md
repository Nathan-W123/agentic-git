# Coordination Overhead

Coordinated runs were taking roughly as long as uncoordinated ones, which
raised a fair question: how much of that is the coordinator itself?

## Method

Profiling wrapped prototype methods at runtime rather than editing the
services, so the measurements describe the shipped path and not a variant built
for measuring.

The first pass ran against a **scripted** scenario. Scripted agents answer
instantly, so with agent latency removed, whatever remains is coordination
overhead proper.

## Where the time went

From an 18-second scripted coordinated run:

| Area | Summed | Share |
| --- | --- | --- |
| integration (worktree, apply, validate, promote) | 10758 ms | 58% |
| git plumbing | 10340 ms | 56% |
| workspace create/destroy | 4986 ms | 27% |
| repository indexing | 2091 ms | 11% |
| **conflict detection and scoring** | **2 ms** | **0.0%** |

Conflict detection was never the cost. Neither were leases, ownership, or
audit logging. The time went to launching processes and to work being issued
one item at a time.

### Replanning is quadratic

Every task still queued has to see the canonical state the previous wave
produced, and each of those replans is a full round trip to an agent. Forcing
full serialisation and counting them:

| Tasks | 2 | 3 | 4 | 5 | 6 | 8 |
| --- | --- | --- | --- | --- | --- | --- |
| Replans | 1 | 3 | 6 | 10 | 15 | 28 |

That is n(n-1)/2, in the single most expensive operation the system performs.
Scripted agents hide it completely. With a real agent at a minute per replan,
eight tasks is close to half an hour of planning alone.

They were also issued strictly one after another, while initial planning a few
hundred lines away was already parallel.

## Changes

1. **Replans run in parallel.** Each reads canonical and a shared index that
   are immutable within a wave, and writes only to its own entry and agent
   session. `appendAudit` runs `BEGIN IMMEDIATE` with no `await` inside the
   transaction, so concurrent appends cannot interleave and the hash chain
   holds; only the ordering of events between tasks changes. Task execution
   below already ran concurrently on the same basis.
2. **Index reads run a chunk ahead.** One `git show` per file meant spawning
   dominated: sixty files took 15.3 s sequentially against 5.8 s sixteen at a
   time. The byte budget still decides inclusion in the same sequential order,
   so the index produced is unchanged.
3. **Branch-name validation is remembered.** `git check-ref-format` reads no
   repository state and answers identically every time, yet ran on every
   `getCanonicalVersion` — about fifteen launches per run.
4. **`getCanonicalVersion` takes one round of processes** instead of two.
   Both remaining queries accept a ref name, so resolving it first was
   unnecessary, and `for-each-ref` supplies the commit date.

None of this changes coordination semantics. Conflict detection, leases, atomic
promotion, validation, and audit logging are untouched.

## Measured effect

### Replan scheduling, isolated

Everything held fixed, `requestReplan` given a 2-second delay to stand in for
agent latency:

| Tasks | Serial | Parallel | Change |
| --- | --- | --- | --- |
| 3 | 24.0 s | 20.1 s | -16% |
| 5 | 49.0 s | 40.3 s | -18% |
| 8 | 113.0 s | 64.0 s | **-43%** |

### End to end, real agents

Host throughput drifts enough to swamp the effect being measured — the scripted
benchmark produced ~17 s and ~35 s for identical code hours apart. Before and
after were therefore alternated back to back, so drift lands on both.

The uncoordinated arm is the control: it touches neither the coordinator nor
the index, so it only sees the shared git plumbing.

| Round | | Coordinated | Uncoordinated |
| --- | --- | --- | --- |
| 1 | before | 341.5 s | 318.7 s |
| 1 | after | 287.2 s | 311.9 s |
| 2 | before | 383.1 s | 394.3 s |
| 2 | after | 301.1 s | 364.8 s |
| | **mean before** | **362.3 s** | 356.5 s |
| | **mean after** | **294.1 s** | 338.3 s |
| | **change** | **-18.8%** | -5.1% |

Round 2 ran about 12% slower than round 1 on both builds, which is the drift
the interleaving exists to absorb. The control moved -5.1% and the coordinated
arm -18.8%; the difference between them is the scheduler work.

Coordinated is now below uncoordinated (294.1 s against 338.3 s) with behaviour
unchanged: 3/3 completed, three integration attempts against five, in every
run.

## Known and not addressed

- **The replan count is still n(n-1)/2.** Only the serialisation was removed.
  Lowering the count means skipping replans whose canonical change does not
  intersect a task's declared resources, which changes what an agent is
  guaranteed to observe. Worth revisiting if measurement at higher task counts
  shows replanning dominating.
- **Integration within a wave stays sequential.** Same-wave tasks are
  non-conflicting by construction, so parallelising is tempting, but validation
  runs against the previous canonical version before promotion. Validating
  concurrently and promoting in sequence would mean the second task's tests
  never saw the first task's changes, which weakens the validation gate.
- **Cached indexes are deep-cloned on every read.** Immaterial at twelve files,
  real on a large repository. Removing the clone hands callers a shared mutable
  index.
- **Workspaces are created and destroyed per task.** About 3.6 s of a scripted
  run. Reuse trades away isolation.
