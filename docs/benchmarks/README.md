# Coordination Benchmark

Every scenario runs the same task set twice against a fresh seed repository:

- **coordinated** — plans are submitted first, file overlap is scored, and
  colliding tasks are sequenced into waves.
- **uncoordinated** — every task starts from the same revision and integrates
  in submission order, replaying once when its patch no longer applies.

Scripted agent behavior makes each scenario deterministic, so a change in the
numbers below is a change in the coordinator rather than agent noise.

```powershell
npm.cmd run benchmark                      # default scenario (mixed)
npm.cmd run benchmark -- --scenario=overlap
npm.cmd run benchmark -- --json
```

## Scenarios

### `overlap` — 2 tasks

The original Phase 0 proof. Two tasks edit the same function.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 2/2 | 1 | 2 | 0 | 0 (0.0) | 0 |
| uncoordinated | 2/2 | 0 | 3 | 1 | 1 (0.5) | 0 |

Ownership sequences the second task, so it builds its patch on the accepted
result of the first instead of a stale revision.

### `mixed` — 5 tasks (default)

Three tasks contend for one function while two independent tasks run free. This
is the scenario that distinguishes *sequencing* from *serializing*: the three
counter tasks are ordered, but the format and config tasks are approved
immediately and run in the first wave.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 5/5 | 3 | 5 | 0 | 0 (0.0) | 0 |
| uncoordinated | 5/5 | 0 | 7 | 2 | 2 (0.4) | 0 |

Three warnings are the three overlapping pairs. Both modes finish all five
tasks; the baseline needs 40% more integration attempts to get there.

### `dependency` — 2 tasks

A signature change and a new caller of that signature, in different files. This
scenario exists to measure a known gap rather than hide it.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 1/2 | 0 | 2 | 1 | 0 (0.0) | 1 |
| uncoordinated | 1/2 | 0 | 3 | 2 | 1 (0.5) | 1 |

Phase 0 scores file overlap only, so no conflict is predicted and both tasks run
concurrently. The second changeset applies cleanly and then fails validation.
Coordination does not prevent this; it only avoids the wasted replay. Detecting
it needs the Level 3 dependency analysis described in `instructions.md` §12.

## Metrics

| Metric | Meaning |
| --- | --- |
| `tasksCompleted` / `completionRate` | Tasks that reached canonical. |
| `conflictWarnings` | Pairs the detector scored as overlapping. |
| `integrationAttempts` | Calls into the integration service. |
| `integrationFailures` | Attempts that did not reach canonical. |
| `reworkCount` / `reworkRate` | Replays performed after a failed attempt. |
| `undetectedConflicts` | Failures for tasks no conflict was predicted for. |

`reworkCount` is 0 for coordinated runs by construction: the scheduler sequences
colliding work rather than replaying it. That is why `integrationFailures` is
reported separately — without it, an unrecovered coordinated failure would look
identical to a clean run. The `dependency` scenario is the case that makes the
difference visible.

Rates are reported alongside counts so scenarios of different sizes compare
directly. Elapsed time is recorded for observation only; process spawn cost
dominates it in this local fixture, and it is not treated as meaningful.

## Repetition

`--repeat=<n>` runs the whole benchmark n times. The scripted scenarios are
deterministic, so repetition only varies timing. It is meaningful with `--live`,
where a real agent may plan or edit differently between runs.

## Validation integrity

Validation commands run through `runProcess`, which strips `NODE_TEST_CONTEXT`
from the child environment. Node's test runner sets that variable in its
children, and a nested `node --test` that inherits it reports through the
parent's IPC channel and exits 0 even when its own assertions fail. Without the
strip, every benchmark executed inside the test suite would promote changesets
without actually validating them. `services/repository-service` carries a
regression test for this.
