# Does coordinating a queue pay off? A ten-task, five-agent measurement

Every coordination experiment in this repository before this one compared two
configurations of the coordinator against each other: grounding on versus off,
warm replan versus cold, partial admission versus all-or-nothing. None of them
asked whether coordinating a queue beats not coordinating it, and none of them
ran at a size where the answer could plausibly go either way. This one does
both, once, and reports what happened.

Read it as a first measurement, not a settled result. It is a single run per
arm. What a single run can establish is whether the effect is large enough to
be worth designing a powered experiment around, and — because correctness is
a categorical outcome rather than a noisy statistic — whether uncoordinated
execution loses work at this scale at all.

## Why the earlier scenarios could not answer this

The existing live scenarios fail in one of two directions.

`live-checkout-trio` and `live-checkout` are *uniformly contended*: every task
must change how an order total is computed, so a correct scheduler serialises
all of them. There is no independent work for coordination to protect and no
parallelism for it to preserve, so the arms can only differ in overhead.

The grounding scenarios are the opposite. Their tasks barely interact, so no
mechanism fires and both arms do the same thing at the same cost — the null
experiment that `remote-path-mechanisms.md` describes running into from the
other direction.

A real backlog is neither. It is mostly independent work with a contended core,
and the interesting question — does isolating the independent work while
serialising the core beat letting everything run and repairing the damage — is
invisible at both extremes.

## The scenario

`team-queue` (in `apps/worker/scripts/team-queue-scenario.mjs`) is ten requests
over five agents against one small service, in three deliberately different
bands:

| Band | Tasks | Why they are in it |
| --- | --- | --- |
| Deep conflict | 3 | All three must change how `orderTotal` computes a total. No ordering makes them independent. |
| Partial overlap | 3 | Each owns one module that `total.js` imports. They can run with each other, but not with a task rewriting their caller. |
| Independent | 4 | Notifications, audit, export, search. No imports into pricing or into each other. |

Objectives never name a file, which is the standing convention for live
scenarios here: the bands are a property of the repository, so the agents have
to discover the overlap the way they would on real work. Five agent ids, two
tasks each, spread across bands so that an agent-level effect cannot be
mistaken for a band-level one.

Which pairs genuinely conflict is written down in the scenario file *before any
run happened* (`TEAM_QUEUE_TRUE_CONFLICTS`): all deep–deep pairs and all
deep–partial pairs, and nothing else. Pre-registration is what stops the label
being fitted to the result afterwards.

## The two arms

**Coordinated.** One canonical repository, ten tasks, five remote workers
leasing against one control plane. Plans are arbitrated, conflicts detected,
contended work sequenced or requeued, results integrated against a moving
canonical.

**Uncoordinated.** The same ten tasks, the same five workers, the same agents,
the same machinery — but each task is bound to *its own* canonical repository,
all ten seeded from one identical source commit. No two tasks ever share a
repository, so the coordinator never compares two plans, never detects a
conflict, never sequences and never requeues. Every agent plans and executes
against the same untouched base, exactly as five developers would on five
branches cut the same morning.

Starving the coordinator of anything to coordinate is a better control than
stubbing it out: both arms run identical code with identical token accounting,
and the only thing that differs is whether the work is comparable.

Both arms get exactly five execution slots
(`COORD_REPOSITORY_PARALLELISM=5`, five workers), so neither is throttled by a
cap the other does not have.

### Settling the uncoordinated arm's debt

The coordinated arm integrates as it goes. The uncoordinated arm finishes owing
ten diffs against one base that have to become one tree, and an honest
comparison has to make it pay. The harness does what a team without a
coordinator does:

1. Apply each task's diff in the order the tasks actually finished, three-way.
2. Where the merge refuses, the later task wins the file outright — which is
   what "whoever finishes last wins" means once it is precise enough to run.
3. Charge a fixed manual-repair penalty per conflicted file for the human who
   would have had to sit down and resolve it.

The penalty is a parameter (`--repair-penalty-seconds`, default 300). It is an
assumption, not a measurement, so every figure below is reported both with and
without it, and the arm's measured machine time is never adjusted.

## How correctness is measured

Statuses record what the system believed. The question here is what is actually
in the repository, so it is checked mechanically: every line a task's patch
adds is looked for in the final tree. A task whose added lines are missing had
its change overwritten by someone else's.

This matters more than any timing number, because a run that loses work did
less work. Two arms are only comparable if they both shipped what was asked
for.

## Results

One run per arm, real Codex, five workers each
(`docs/benchmarks/data/team-queue/*-live3-*.json`).

| | Coordinated | Uncoordinated |
| --- | --- | --- |
| Tasks integrated | 6 of 10 | 5 of 10 |
| **Tasks losing work** | **1** (partial) | **2** (one total) |
| Merge conflicts to repair by hand | 0 | 4 |
| Final tree tests | pass | pass |
| Tokens total | 3,034,793 | 1,825,618 |
| — planning | 2,262,134 (75%) | 688,947 (38%) |
| — execution | 772,659 | 1,136,671 |
| **Tokens per integrated task** | **505,799** | **365,124** |
| Conflicts detected | 103 | 0 |
| Replans / deferrals | 16 / 73 | 0 / 0 |
| Lease iterations for 10 tasks | 98 | 34 |
| Budget exhausted | yes | yes |

Neither arm finished, for different reasons, so "6 versus 5" is not a
throughput result. The coordinated arm stalled — see below. The uncoordinated
arm simply still had five tasks executing when its budget expired.

### Coordination cost 39% more per completed task

And the shape of the spend is the finding, not the total: **75% of the
coordinated arm's tokens went to planning**, against 38% uncoordinated. It
bought 3.3× the planning tokens to deliver one more task. 98 lease iterations
for ten tasks is the same fact stated another way — most planning was thrown
away.

### The coordinated arm livelocked

Four tasks never completed, and not for want of time:

```
approved   task_717f068d ... ownership granted
blocked    Plan collides ... beyond the sequencing threshold: task_717f068d
blocked    ... (repeating until the budget expired)
```

A `block` disposition tells the holder to "plan again with a narrower scope".
A task whose objective is to change how an order total is computed has no
scope to shed: it replans, produces a materially identical plan, and is
refused identically. There was no bound on that loop and no escalation out of
it, so the contended core of the queue never drained while each turn bought
another ~23,000-token planning round.

Two changes bound it, each carrying its own tests:

- `BLOCKED_ATTEMPTS_BEFORE_SEQUENCING` in
  `services/coordinator/src/plan-admission.ts`. After two refusals on the same
  collision the answer changes from "plan again" to "wait behind this holder".
  Sequencing is a stricter promise than blocking, not a weaker one — the task
  still gets no permission to run — so this buys liveness without conceding
  any safety.
- `leaseWork` in `apps/cli/src/worker-operations.ts` now sends tasks known to
  be waiting on still-running work to the back of the queue. Planning is paid
  for at lease time, before the coordinator is consulted, so leasing such a
  task buys a full planning round to be told to wait again. It is an ordering
  preference and never an exclusion: if everything is waiting, a worker still
  takes one, so nothing can starve.

### Verifying the fix

A seven-task run over the contended core plus the independent band
(`--bands=deep,independent`, four workers, real Codex,
`*-livelockfix-*.json`), against the ten-task run above. The ratios are what
transfer between two runs of different size; the absolute totals do not.

| | Before | After |
| --- | --- | --- |
| Deferral rate (share of leases refused) | 74% | **29%** |
| Leases per task | 9.8 | **3.4** |
| Planning share of tokens | 75% | **49%** |
| Worst single task, leases spent | 22 | **5** |

No task span dozens of turns being told to narrow a plan it could not narrow.
That is the loop closing.

**The escalation itself never fired.** No task reached a third consecutive
refusal on one collision, because the lease-ordering change stopped it being
handed back its own dead end in the first place: refused once, a task goes to
the back of the queue, and by the time it returns the blocker has usually
integrated. So the measured improvement is attributable to the lease ordering,
and `BLOCKED_ATTEMPTS_BEFORE_SEQUENCING` remains unexercised insurance for the
case the ordering cannot help — a queue holding nothing but tasks waiting on
one holder. It is covered by unit tests and not by this run, and should not be
described as live-validated.

The run is not clean in other respects: it exhausted its budget at 73 minutes
with three of seven integrated, and fourteen iterations died on transport
errors, which is now the largest single failure category. Coordination churn
is no longer the binding constraint on this path; the worker's habit of
failing a task outright on a dropped connection is.

### Correctness is where coordination earned its keep

The uncoordinated arm lost both deep-band tasks: `handling_fee` was **wholly
overwritten** — none of its four added lines survive in the final tree — and
`free_delivery` came through with two of twelve. Four files needed manual
merge repair, all of them `src/pricing/total.js` and its test. The coordinated
arm lost one line of one task and had no merge conflicts at all.

**Both final trees passed their tests.** Validation did not notice the
destroyed work in either arm, which is the part worth carrying forward: a
green suite after an uncoordinated merge is not evidence that the merge kept
what the tasks were asked to do.

## Limitations

- **One run per arm.** Every figure here is a single sample.
- **Wall clock is not reported, because it was contaminated.** A previous
  run's uncoordinated arm was still executing when this run's coordinated arm
  started, and the two shared the machine for 113 minutes. Token counts and
  correctness are properties of the work done and are unaffected; elapsed time
  is not, and no timing comparison should be read off this data.
- **Harness-induced task deaths remain.** 17 and 29 iterations respectively
  ended in transport errors, and a worker that hits any error inside a lease
  reports the *task* failed with no retry. At least one coordinated task died
  that way rather than from coordination.
- **The scenario had to be repaired once.** An earlier version put all four
  independent features in one test file and all six pricing tasks in another,
  so every agent correctly declared a shared test file and the whole queue
  serialised into two chains. Shared test files do serialise real teams, but
  it made the bands meaningless here. One test file per module now.
- **One repository, one domain, one agent.**
