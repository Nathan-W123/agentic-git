# Coordination Benchmark

Every scenario runs the same task set twice against a fresh seed repository:

- `coordinated`: plans are analyzed first, dependencies and conflicts form
  scheduling waves, and blocked tasks replan against accepted canonical work.
- `uncoordinated`: every task starts from the same revision and integrates in
  submission order, rebuilding once after a stale failure.

Scripted agents keep results deterministic, so metric changes reflect
coordinator behavior rather than model variance. That determinism is bought by
having the fixture supply the plan the detector is later graded on, so these
scenarios measure the coordinator, not the premise it rests on. For the same
comparison against a real agent whose plans are not known in advance, see
[live-evidence.md](live-evidence.md); for where a coordinated run spends its
time, see [performance.md](performance.md). For why the intent-level conflict
signal is scored but never scheduled on — a negative result, on a registered
held-out split — see [intent-signal.md](intent-signal.md).

```powershell
npm.cmd run benchmark
npm.cmd run benchmark -- --scenario=overlap
npm.cmd run benchmark -- --scenario=dependency
npm.cmd run benchmark -- --json
```

## Scenarios

### `overlap`: 2 tasks

Two tasks edit the same function.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 2/2 | 1 | 2 | 0 | 0 (0.0) | 0 |
| uncoordinated | 2/2 | 0 | 3 | 1 | 1 (0.5) | 0 |

Ownership sequences the second task, so it builds against the first accepted
result rather than a stale revision.

### `mixed`: 5 tasks (default)

Three tasks contend for one function while two independent tasks run in the
first wave.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 5/5 | 3 | 5 | 0 | 0 (0.0) | 0 |
| uncoordinated | 5/5 | 0 | 7 | 2 | 2 (0.4) | 0 |

This distinguishes sequencing from serialization: the colliding chain is
ordered while unrelated work remains concurrent.

### `dependency`: 2 tasks

One task changes a function contract and another adds a caller in a different
file.

| Mode | Completed | Warnings | Attempts | Failed | Rework | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| coordinated | 2/2 | 1 | 2 | 0 | 0 (0.0) | 0 |
| uncoordinated | 2/2 | 0 | 3 | 1 | 1 (0.5) | 0 |

Dependency evidence identifies the producer, sequences it first, and sends the
consumer a canonical-change notice. The consumer replans before editing and
integrates on its first attempt. The baseline starts stale, fails validation,
then rebuilds.

This scenario was the original file-only detector's known miss. It now serves
as a regression test for Level 3 dependency coordination and dynamic
replanning.

## Other measurements in this directory

Scenario runs answer "does coordination pay for itself". These answer narrower
questions about one mechanism each, and are listed here so they are findable:

| Page | Question | Driven by |
| --- | --- | --- |
| [live-evidence.md](live-evidence.md) | Does the advantage survive real agents? | `coord benchmark --live` |
| [plan-grounding.md](plan-grounding.md) | What is verifying an agent's declarations worth? | `scripts/grounding-experiment.mjs` |
| [partial-admission-granularity.md](partial-admission-granularity.md) | How much uncontested work does a withholding discard? | `scripts/measure-hunk-withholding.mjs`, `scripts/verify-patch-division.mjs` |
| [performance.md](performance.md) | Where does a coordinated run spend its time? | `--json` timings |

## Metrics

| Metric | Meaning |
| --- | --- |
| `tasksCompleted` / `completionRate` | Tasks promoted to canonical |
| `conflictWarnings` | Plan pairs with recorded conflict evidence |
| `integrationAttempts` | Calls into transactional integration |
| `integrationFailures` | Attempts that did not promote canonical |
| `reworkCount` / `reworkRate` | Rebuilds after a failed stale attempt |
| `undetectedConflicts` | Failures not predicted by available evidence |

Elapsed time is observational only. Local Git and process startup dominate
these fixtures, so the benchmark evaluates correctness and rework rather than
claiming representative wall-clock performance.

## Repetition And Live Agents

`--repeat=<n>` repeats a complete benchmark. Deterministic scripted scenarios
only vary in timing. Repetition is useful with `--live`, where a real agent can
produce different plans or edits.

## Validation Integrity

Validation strips `NODE_TEST_CONTEXT` from child environments. This prevents a
nested `node --test` process from reporting through the parent harness and
masking a failing repository test. The repository service includes a
regression test for this boundary.
