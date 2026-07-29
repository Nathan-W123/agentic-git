# Plan Grounding: Verifying Declarations Against the Repository

This page covers two fixes to the same underlying waste — coordination
effort spent where it cannot pay off:

1. **Plan grounding**: admission arbitrated on agent declarations that were
   sometimes fiction, so real collisions went undetected until integration.
2. **The solo fast path**: a task alone in its repository paid the full
   arbitration cost — index build included — to be compared against nobody.

## The problem, as recorded

Every admission decision — conflict scoring, ownership, wave scheduling —
arbitrates on what an agent *declares* it will touch (`expectedFiles`,
`expectedSymbols`), before that agent has edited anything. A live experiment
on 2026-07-29 (real Codex agents, real repository, objectives that never name
a file) showed what that trust costs:

- Agents declared file paths that do not exist (`src/checkout.js`,
  `src/order.js` — invented; the real module is `src/pricing/total.js`).
- In one run, two agents independently invented the *same* wrong name for the
  real `orderTotal` (`calculateTotal`), which made the detector flag a
  "conflict" — a correct answer produced by two matching mistakes.
- In a re-run, they invented *different* wrong names, the declared plans
  shared nothing, both tasks were admitted concurrently, and one execution
  was thrown away at integration time.

Plan-time detection was exactly as reliable as the agents' guesses, which is
to say: not reliable at all. The exact-base integration backstop caught the
damage, but at the price of a full agent execution — the most expensive way
to discover a conflict this product has.

## The fix

`groundPlan` (services/code-intelligence/src/plan-grounding.ts) verifies
every declaration against the base-revision repository index, deterministically:

- A declared file either exists at that revision or it does not. A missing
  path is mapped to real files with the same basename or path suffix
  (`src/order.js` → `src/models/order.js`); an invention with no counterpart
  maps to nothing and is treated as a new file.
- A declared symbol either resolves in the index or it does not. An
  unresolved name is mapped to real symbols by identifier-token overlap
  (`calculateTotal` → `orderTotal` through the shared content token "total";
  generic verbs like "calculate" and "get" cannot anchor a match), and each
  referent brings the files where it is declared.

The mapped referents feed *arbitration only*: `arbitrationFiles` /
`arbitrationSymbols` merge them into overlap detection, so two plans that
misname the same real code in different ways now collide on the real thing.
Write-scope enforcement still holds every agent to the files it declared —
grounding never widens what a changeset may touch, so no existing safety
guarantee is weakened.

Each plan carries a confidence verdict:

| Verdict | Meaning | Treatment |
| --- | --- | --- |
| `verified` | every declared file exists, every symbol resolves | unchanged behaviour |
| `grounded` | some declarations corrected or novel, at least one anchor | unchanged thresholds, wider footprint |
| `ungrounded` | nothing declared connects to the repository | no concurrency with work about the same objective; no partial admission |

An `ungrounded` plan is not automatically a lying one: a task creating a new
module declares only files that do not exist yet, and scope enforcement holds
it to those declarations either way. What separates the hallucination from
the honest creation — statically indistinguishable in their resource claims —
is the stated objective. An unverifiable plan is therefore serialised
against executing or pending work whose objective shares vocabulary with its
own (`relatedObjectives`), in the local wave scheduler and in remote plan
admission alike, and keeps its concurrency against unrelated work. The full
test suite caught the blunter first version of this rule punishing a
create-a-new-module task; the refinement is documented by tests in both
directions. A truncated index never condemns a plan as ungrounded: the
declarations may resolve in exactly the files the byte budget skipped.

`COORD_DISABLE_PLAN_GROUNDING=1` restores the pre-verification behaviour on
an identical build. It exists for operational rollback and for the
measurement below; it is strictly less safe.

## Deterministic replay of the recorded failure

`services/coordinator/src/conflict-detector.test.ts` replays the recorded
hallucinated plan pair verbatim: `src/checkout.js` + `calculateTotal` against
`src/order.js` + `computeOrderTotal`. Without grounding the detector returns
no assessment at all — the recorded failure. With grounding both plans map to
`orderTotal` in `src/pricing/total.js` and score 55 (file 20 + symbol 35):
**sequence**, which is the correct answer. This holds regardless of which
wrong names the agents invent, because the mapping goes through the real
code, not through the coincidence of matching mistakes.

## Live measurement

All live data is under `data/grounding/` (one JSON per run, written by
`scripts/grounding-experiment.mjs`; `scripts/summarize-grounding-runs.mjs`
tabulates it). Scenario `live-checkout`, two real Codex agents, objectives in
checkout vocabulary that never name a file or symbol; both tasks must change
`orderTotal` in `src/pricing/total.js`. The before arm runs the same build
with `COORD_DISABLE_PLAN_GROUNDING=1`, so the arms differ by exactly the fix.

### A hallucinating session (morning, `data/grounding/sandbox-broken/`)

Codex's planning behaviour turned out to swing by session. In the morning
collection, **10 of 12 plans across six runs declared files that do not
exist** (`checkout.js`, `src/checkout.js`, `checkout.test.js`) or declared no
files at all, and invented symbols (`calculateTotal`, `deliveryCharge`,
free-text descriptions like "checkout total calculation"). A Codex sandbox
defect (see below) invalidated execution outcomes for these runs, but
planning is a read-only phase and the plan-time numbers stand:

| Arm | Runs | Pair flagged at plan time | Flagged strongly enough to sequence |
| --- | --- | --- | --- |
| Grounding off | 5 | 1 of 5 | 0 of 5 |
| Grounding on | 1 | 1 of 1 | 1 of 1 (ungrounded plan isolated to its own wave) |

The one grounding-off detection came from both agents inventing the *same*
wrong names — matching mistakes, scored 40, still admitted concurrently. In
the grounding-on run, one plan was corrected (`calculateTotal` →
`orderTotal`, pulling in `src/pricing/total.js`) and the other — which
declared nothing that exists — was ruled ungrounded and serialized behind
verifiable work by policy, exactly the containment the fix promises when
correction has nothing to anchor to.

### An accurate session (afternoon, clean sandbox, 4 runs per arm)

In the afternoon collection the same agents on the same prompts planned
accurately in every run (real files, real symbols, plus legitimately new
files like `src/pricing/delivery.js`). This is the no-regression check:

| | Before (grounding off) | After (grounding on) |
| --- | --- | --- |
| Pair flagged at plan time | 4 of 4 (score 100, block) | 4 of 4 (score 100, block) |
| Tasks completed | 7 of 8 | 6 of 8 |
| Integration failures | 0 | 0 |
| Undetected conflicts | 0 | 0 |
| Tokens per run | 109k–135k | 74k–138k |

Detection is byte-for-byte identical when plans are accurate — grounding adds
nothing and costs nothing. Every incomplete task in both arms (one before,
two after) failed the same way: the Codex CLI intermittently produced no
edits under its Windows `workspace-write` sandbox and the adapter's
`CodexWriteDeniedError` guard refused to record an empty changeset as
success. That flake is environmental, hit both arms, and never reached
integration; no run in either arm had an integration failure or an
undetected conflict. Grounding verdicts on these accurate plans: `verified`
for fully-resolving plans, `grounded` for plans declaring new files — never
a false `ungrounded`, so no legitimate creation lost concurrency.

Read together: in sessions where agents plan accurately, before and after
behave identically; in sessions where agents hallucinate — which is when the
old system silently granted colliding work free concurrency — grounding
either corrects the declarations onto real code or refuses to schedule the
unverifiable plan beside anything.

### Infrastructure note

The current Codex alpha (0.146.0-alpha.3.1) ships without its elevated
Windows sandbox setup helper; every scoped write fails with
`orchestrator_helper_launch_failed`. Live runs here use
`COORD_CODEX_WINDOWS_SANDBOX=unelevated` (still a scoped-write sandbox).
Even with that, roughly one execution in five produced no edits and was
correctly failed by the adapter rather than integrated empty.

## The solo fast path

`admitWorkPlan` used to build the repository index — one `git show` per
source file — then enrich, ground and score the plan, before approving it
against an empty set of active work. The worker sat blocked on that round
trip. Now the active set is read first, and when it is empty the plan is
approved on the spot.

What is skipped is the wait, never the safety:

- The store write is compare-and-swap on the set of admitted leases
  (`saveWorkLeasePlan` returns `stale` when it changed), so two workers going
  solo simultaneously collide at the write and the loser falls through to
  full arbitration against the winner.
- A later arrival enriches and grounds the fast-path plan on the fly before
  arbitrating against it. Both are deterministic functions of plan and
  index, so the comparison sees exactly what full admission would have
  stored (`worker-operations.test.ts`: a hallucinated second plan is
  sequenced behind a fast-path first plan through a grounded referent).
- Exact-base integration still gates every result at promotion: a changeset
  built on a stale base is replayed if the advance is disjoint and requeued
  to replan if not, exactly as before.

The local coordinator gets the same economics: a single-task run skips the
index entirely, and any wave with nothing to replan skips rebuilding it.

Measured with `scripts/solo-admission-benchmark.mjs` (real git repository,
300 source files, fresh services per sample so every admission pays the
cold-index cost, 5 samples each):

| Condition | Median | Min | Max |
| --- | --- | --- | --- |
| Solo admission (fast path) | 232 ms | 169 ms | 8,897 ms* |
| Full arbitration (one disjoint neighbour) | 10,270 ms | 7,677 ms | 19,441 ms |

*The first solo sample pays process warm-up; every subsequent one is
sub-400 ms.

Full arbitration with one disjoint neighbour is, within milliseconds of
conflict scoring, what a solo admission paid before the fast path: the cost
is the index build, and it grows with repository size. **Median saved: ~10.0
seconds per solo admission on a 300-file repository** — pure waiting removed
from every task that runs alone, which is the common case for a
single-developer repository.

## Limitations

- Token-overlap matching is lexical. A hallucinated name that shares no
  content token with the real symbol (`settleBasket` for `orderTotal`)
  grounds to nothing; if the rest of the plan is equally fictional the plan
  is ungrounded and loses concurrency (safe), but if the plan also declares
  one real file, the miss is not corrected and detection again depends on
  the declared overlap.
- Grounding can over-connect: a referent the agent never intended adds a
  spurious sequencing edge. The cost is lost parallelism for one wave, never
  lost safety, and referents are capped at three per declaration with
  generic tokens excluded to bound the effect.
- The objective text is not yet used as an independent discovery signal; a
  plan that declares plausible-but-wrong *existing* files (real files the
  task will not actually touch) is still taken at its word. That failure
  mode is invisible to any static check of the declarations alone.
