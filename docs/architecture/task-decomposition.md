# Intake-Time Task Decomposition

## Why this exists

Every conflict mechanism in this coordinator is downstream of the same
decision, and nothing was making it: **how much of the repository one task is
allowed to be about.**

The pipeline detects planned overlap, arbitrates admission, sequences
dependencies, withholds resources, replans against canonical change, and
repairs collisions at integration. All of that operates on a task whose size
was fixed before any of it ran — at submission, by a person writing one
sentence. A task whose real footprint spans four independent modules acquires
leases across four independent modules and holds them for its entire life.
Every concurrent task needing any of those four waits, replans, or collides,
and none of the downstream machinery can undo that, because by then the task is
atomic by definition.

Decomposition is the first lever that acts on the cause rather than the
symptom: if the same work can enter the queue as several tasks with narrower,
non-overlapping scope, three of those four collisions never exist to be
detected.

This is prevention, not detection. It does not replace anything. Conflict
detection, admission arbitration, and the integration backstop are unchanged
and still carry all the correctness weight.

## Where it sits

```
coord task submit --objective=…
        │
        ▼
  TaskIntakeService                    services/coordinator/src/task-intake.ts
        │
        ├── canonical version ────────► RepositoryService
        ├── repository index ─────────► CodeIntelligenceService
        ├── estimateScope(objective) ── services/coordinator/src/scope-estimation.ts
        ├── contention (leases + queue)
        └── decomposeTask(…) ────────── services/coordinator/src/task-decomposition.ts
        │
        ▼
  store.submitTask() × 1 or N   +   audit `task_decomposed`
        │
        ▼
  coord run → agent plans → [existing pipeline, unchanged]
```

Intake is the last moment at which the size of a unit of work is still
negotiable, which is exactly why the decision belongs here and nowhere later.

## Estimating scope before a plan exists

Every other scope judgement in the system starts from an agent's plan, because
that is the first *declared* scope. Intake has no plan, so it has to estimate,
and it does so with the same machinery plan grounding already uses — pointed at
prose instead of at declarations.

`estimateScope(objective, index)` runs entirely against the repository index at
the current canonical revision. No model call; nothing an audit cannot replay.

1. **Literal paths first.** Path-shaped substrings of the objective are
   resolved against real repository paths and directories. Naming the place is
   the strongest statement an objective can make about scope, so those words
   are spent there and not reused as loose tokens.
2. **Identifier fragments.** Remaining words are split into lowercase
   fragments (`identifierTokens`, shared with plan grounding), stemmed for
   regular English plurals, and filtered against a stop list. The stop list
   mixes ordinary filler ("the", "should") with generic engineering vocabulary
   ("service", "handler", "update") — the latter because it is evenly
   distributed and therefore localizes nothing.
3. **Ubiquity filter.** A fragment matching more than 15% of indexed files is
   discarded outright and the discard is recorded. An objective saying "test"
   is not evidence about *which* tests.
4. **Scoring.** Surviving fragments are matched against declared symbols,
   declared resources (APIs, schemas, config keys, services), directory
   segments, and file basenames, each with its own weight. Files above the
   threshold, capped at 40, form the estimate.
5. **Grouping.** Estimated files are grouped by module root, and module roots
   are read out of the repository — directories owning a build manifest, with
   top-level directories as the fallback. The unit a split respects is the unit
   the repository already declares.

The estimate reports its own confidence and is required to be read as weak:

| Confidence | Meaning | Effect |
| --- | --- | --- |
| `anchored` | Something matched a named path, directory, symbol, or declared resource | The only state a split may be considered in |
| `weak` | Only file basenames matched | Never split |
| `none` | Nothing matched at all | Never split |

The estimate grants nothing, withholds nothing, and enforces nothing. Its only
consumer is the split decision.

## The decision: a list of reasons not to split

A bad split is strictly worse than no split. Two halves of a change that had to
compile together produce two changesets that each fail validation, and the
platform pays for two agent runs to get less than one. So the policy is written
as a series of vetoes with a default answer of *no*, and every veto returns a
named reason.

| Reason | Refuses because |
| --- | --- |
| `disabled` | The mode is `off`. |
| `unknown_scope` | The estimate is `none` — splitting on ignorance is the worst case. |
| `weak_scope` | The estimate is `weak` — too thin to divide work on. |
| `too_small` | Fewer than 4 estimated files; not worth the cost. |
| `single_module` | The footprint sits in one module; nothing independent to separate. |
| `atomic_objective` | The wording announces an indivisible change. |
| `coupled_modules` | The candidate pieces depend on each other. |
| `too_fragmented` | More than 4 pieces; the estimate spread rather than localized. |
| `no_contention` | Nobody is competing for this footprint (default mode only). |
| `no_relief` | Everything is contended, so no split can run free (default mode only). |
| `split` | None of the above applies. |

### Atomicity: the wording veto

The changes that *must* land together — renames, refactors, extractions,
moves, migrations, version bumps, deprecations — announce themselves in the
objective. `atomicSignals()` matches a generous list of such wordings and any
match is a veto, not a score, with the matched phrase quoted back so the
refusal can be argued with.

The asymmetry is deliberate. A false positive costs nothing: the task is
submitted whole, exactly as it would have been before this module existed. A
false negative costs a broken split. So the list errs long.

### Coupling: the structural veto

Two module footprints are merged into one piece when a file the estimate
selected in one imports, or references a symbol declared by, a file the
estimate selected in the other. Connected components of that relation are the
candidate pieces; fewer than two components means no split.

**Coupling is judged only among the selected files, never across the whole
repository.** In a monorepo every package imports the shared-types package, so
"these two modules are connected somewhere" is true of every pair and would
veto every split that could ever exist. "The file I am about to change in A
imports the file I am about to change in B" is the question that actually
predicts whether the two halves have to compile together.

### The trigger: contention, not size

Three modes:

- **`off`** — every objective is queued whole. The control arm.
- **`contended`** (default) — split only when other work is already competing
  for part of the estimated footprint *and* at least one resulting piece is
  free of that contention.
- **`always`** — split whenever the footprint is safely separable.

`contended` is the default because splitting is not free. It costs coherence
risk, more runs, more integrations, and more agent context. Paying that in a
repository nobody else is touching is a bad trade; the undivided task would
have collided with nothing. The sharp form of the criterion is that **a split
must strictly reduce the conflicting surface** — hence `no_relief`, which
refuses when every piece is contended anyway.

Contention is read from two sources, strongest first:

1. **Live file leases** on running runs — a real declared scope, the same set
   arbitration itself compares against.
2. **Queued and claimed tasks**, whose objectives are estimated exactly as this
   one's was.

The second source matters more than it looks. A claimed task carries no run id
until it completes, and two large overlapping tasks submitted a minute apart
hold no leases at all — a lease-only view would see an idle repository right up
until they collided.

## What a subtask actually is

Each piece is submitted as an ordinary task carrying the **original objective
verbatim**, followed by an appended scope constraint naming its modules, its
expected files, the sibling scopes, and an instruction to request a scope
change rather than edit outside.

The objective is appended to, never rewritten. Rewriting would mean this module
deciding what the work *means*, which it has no basis for — it matched words
against an index; it did not understand the task. Appending leaves the author's
intent intact and adds the one thing intake genuinely knows.

**This is the honest limit of the mechanism.** `TaskDefinition` carries an
objective, an agent id, and validation commands — there is no durable declared
scope field before the plan exists, so the constraint reaches the agent as
prose. Its enforcement is entirely the existing machinery: the agent's plan is
grounded and arbitrated, mid-execution scope requests are arbitrated, and
`assertChangeSetWithinPlan` holds the result to the plan. Decomposition
*narrows what is asked for*; it does not add a new enforcement primitive. An
agent that ignores the constraint and plans the whole objective anyway ends up
exactly where it would have been without the split — which is the failure mode
being conservative is meant to keep rare.

A split writes a `task_decomposed` audit event with no run id (intake precedes
any run). It is the only record connecting the siblings to the objective they
came from and to the reason they were separated.

## Configuration

CLI: `coord task submit --objective=… [--split=off|contended|always]`.
Defaults to `contended`. A split prints every task id with its scope and
whether it is still contended — the behaviour is visible, not silent.

Programmatic: `new TaskIntakeService(codeIntelligence, repositories, options)`,
where `options` carries the mode, `minFiles`, `minSubtasks`, `maxSubtasks`,
`minFilesPerSubtask`, estimation tuning, and `maxContentionSamples`.

Failure is never fatal to submission. If the canonical version or the index
cannot be read, the objective is queued whole and the result carries a
`degraded` note explaining why.

## Verification status

Static and unit verification only, as of 2026-08-01.

Covered by `services/coordinator/src/*.test.ts` (39 tests):

- Estimation: named paths and directories, symbol and directory localization,
  plural stemming, the ubiquity filter (both directions), anchored vs weak vs
  none, truncated indexes, the file cap, module-root derivation and fallback.
- Decision: every veto above, transitive coupling merges, coupling restricted
  to selected files, symbol-reference coupling, contention relief and its
  absence, mode parsing.
- Intake: real git repository and real store — uncontended objective queued
  whole, contended objective queued as two independent tasks, the audit record
  and its chain, lease-sourced contention, `off`, unindexable repository,
  empty objective.

**Not verified: whether this reduces real conflicts.** That claim needs a live
multi-agent run and was deliberately not attempted here. What a future live
verification should measure, against the `off` mode as a control arm on the
same scenarios:

1. **Does the estimate resemble reality?** Compare each estimated footprint
   against the files the agent's plan actually declared, and against the files
   the changeset actually touched. This is the load-bearing assumption and the
   cheapest thing to falsify — it can be measured from recorded runs without
   ever enabling a split.
2. **Do splits stay in their lane?** For each subtask, how often did the agent
   plan or edit outside its stated scope? A high rate means the prose
   constraint does not bind and the whole mechanism is theatre.
3. **Does it actually reduce conflict?** Conflict assessments per task, tasks
   sequenced rather than run concurrently, replans triggered, and integration
   rejections — split arm versus `off` arm.
4. **What does it cost?** Total agent runs, wall clock, and tokens for the same
   work. A split that removes conflicts by doubling the spend is not a win.
5. **Coherence damage.** Validation failures attributable to a split — the
   failure mode the atomicity and coupling vetoes exist to prevent. This is the
   number that decides whether the feature ships on by default.

The honest prior: the vetoes are tuned to fire often, so the most likely real
outcome is that decomposition rarely triggers at all. That is the intended
failure mode, but "safe" and "useful" are different claims and only the second
one is still open.
