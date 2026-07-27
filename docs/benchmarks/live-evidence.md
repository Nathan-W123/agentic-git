# Live Coordination Evidence

The scenarios in [README.md](README.md) run scripted agents. That is deliberate:
it makes coordinator behaviour deterministic, so a metric change means the
coordinator changed. It also means those numbers prove nothing about real
agents, because the fixture supplies the plan the detector is later graded on.

This page records what happened when the same comparison was run against a real
agent whose behaviour was not known in advance.

## Setup

- **Scenario**: `live-pricing` — a twelve-file order-pricing library with
  passing tests and a barrel `src/index.js`.
- **Agent**: OpenAI Codex, driven through the shipped `CodexAdapter`, one
  process per task.
- **Tasks**: three ordinary product requests, none of which names a file:
  - add a flat two-pound handling fee,
  - make delivery free over one hundred pounds and three pounds otherwise,
  - round displayed amounts to whole pence.

Two of those necessarily change how an order total is computed, so they contend
whether or not the agents notice. Not naming files is the point: naming them
would hand the detector its answer and flatter the result.

## Results

Seven complete runs. Each run executes both arms against a fresh seed
repository.

| Run | Coordinated ms | Uncoordinated ms | Coord attempts | Uncoord attempts | Uncoord rework | Undetected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 404053 | 366676 | 3 | 5 | 2 | 0 |
| 2 | 325805 | 361779 | 3 | 5 | 2 | 0 |
| 3 | 343814 | 372746 | 3 | 5 | 2 | 0 |
| 4 | 341537 | 318659 | 3 | 5 | 2 | 0 |
| 5 | 287246 | 311909 | 3 | 5 | 2 | 0 |
| 6 | 383123 | 394321 | 3 | 5 | 2 | 0 |
| 7 | 301051 | 364782 | 3 | 5 | 2 | 0 |

Every run completed 3/3 tasks in both arms. Runs 2 and 3 additionally cloned
the canonical tree each arm finished on and ran the repository's own tests
against it; both passed. Per-task integration already gates on those tests, but
it gates one task at a time, so this checks the different question of whether
the repository is healthy after everything has landed.

### What is stable

**Integration attempts: 3 coordinated against 5 uncoordinated, in all seven
runs.** The uncoordinated arm failed integration twice and rebuilt twice every
time. This is the load-bearing result — it is measured, it did not vary, and it
is the same collision being found and avoided each run.

**Undetected conflicts: 0 in both arms, in all seven runs.** No integration
failed for a reason the available evidence had not already predicted. With
objectives that never mention a path, the detector found the overlap from the
agents' own plans, scoring the handling-fee and free-delivery pair at 100 on
both file and symbol evidence (`orderTotal`, `subtotal`, `src/pricing/total.js`).

### What varies

Plans differ between runs, because the agent does. Six runs recorded three
conflicting plan pairs; one recorded two. Elapsed time varies by roughly ±40 s
from agent nondeterminism alone, and the host's throughput drifted by more than
that over the course of collection — see the caution below.

### What this does not show

`reworkCount` is reported as 0 for the coordinated arm **by construction**, not
by measurement: the scheduler sequences colliding work rather than replaying
it, and the metric is hardcoded to reflect that. "Rework avoided: 2" therefore
means "the uncoordinated arm reworked twice, and the coordinated arm is defined
not to." The defensible comparison is the attempts column and
`undetectedConflicts`, both of which are genuinely measured.

## Does the advantage grow with task count

Three tasks shows a real collision being avoided. It says nothing about the
claim the product rests on, which is that coordination matters more as more
people work the same repository. `live-pricing-wide` doubles the set to six
requests over the same library, with contention layered rather than uniform:
four change how a total is computed, two change how amounts are displayed, and
two change how discounts are decided.

| | 3 tasks | 6 tasks |
| --- | --- | --- |
| Coordinated attempts | 3 | 6 |
| Uncoordinated attempts | 5 | 11 |
| Uncoordinated failures | 2 | 5 |
| Uncoordinated rework rate | 0.67 | 0.83 |
| **Wasted integration cycles** | **2** | **5** |
| Undetected conflicts, both arms | 0 | 0 |
| Coordinated elapsed | 325-404 s | 724 s |
| Uncoordinated elapsed | 312-394 s | 773 s |

Both arms completed 6/6. The advantage widens: doubling the tasks produced
two and a half times the wasted work for the uncoordinated arm, and its rework
rate rose from two-thirds to five-sixths. The coordinated arm still integrated
each task exactly once.

At six tasks the coordinated arm was also faster in wall-clock terms (724 s
against 773 s), which it was not reliably at three. That is one run, so it is
weaker evidence than the attempts column, but it points the same way.

All fifteen plan pairs were flagged as conflicting, which is every pair — the
six requests genuinely all touch pricing. The scheduler therefore serialised
completely and still finished ahead, because the uncoordinated arm spent five
full agent cycles rebuilding.

Neither arm had an integration fail for an unpredicted reason at either size.

### Caveats

One run at six tasks, against seven at three. The elapsed-time comparison in
particular should not be leaned on until it is repeated.

The final canonical tree was not separately re-tested at six tasks as it was in
runs 2 and 3. It does not need to be for the promotion itself to be sound: each
integration validates against the canonical state it is promoting onto, so the
last successful promotion in each arm ran the repository's tests against a tree
containing every earlier change. Zero integration failures therefore means both
final trees passed at promotion time.

## On elapsed time

Elapsed time is the weakest number on this page and should be read last.

The coordinated arm sequences colliding work into waves; the uncoordinated arm
runs everything at once and redoes what fails. At three tasks with a
~2-minute agent, those two shapes cost about the same, and which one wins on
the clock depends on machine conditions more than on the scheduler.

Host throughput is not stable enough for cross-time comparison. The scripted
benchmark measured ~17 s and ~35 s for identical code at different points
during this work. Any before/after claim about wall-clock time must interleave
the two builds rather than compare runs taken apart. Runs 4-7 above are such an
interleave; see [performance.md](performance.md).

The case for coordination in this data is the two integration cycles it did not
have to spend, not the clock.

## Reproducing

```powershell
$env:COORD_AGENT_CMD = "<path to codex>"
$env:COORD_AGENT_ADAPTER = "codex"
$env:COORD_CODEX_SANDBOX = "danger-full-access"
$env:COORD_AGENT_TASKS = "all"
node apps/cli/dist/index.js benchmark --scenario=live-pricing --live --json
```

`COORD_CODEX_SANDBOX` is required on Windows. Under `workspace-write` Codex
reports a missing sandbox helper, degrades to read-only, and still exits 0 —
the adapter detects that and raises `CodexWriteDeniedError` rather than
recording an empty change set as success.
