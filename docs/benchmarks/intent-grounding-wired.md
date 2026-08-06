# The Grounded Intent Signal Is Wired In — And Is Not Yet Validated

**Read this first: the signal described here was switched on *before* the test
that would justify it, not after.** That is a deliberate decision taken with
the numbers below in hand, and this document exists so that nobody later finds
it in the audit trail and assumes it earned its place there.

Everything measured about it is in `docs/benchmarks/intent-grounding.md`. This
page records what is live, what is known, and what is still owed.

## 1. What is switched on

`ConflictDetector.assess` accepts an injected `IntentConflictAssessment`. When
one is supplied it *replaces* the legacy `intent_conflict` reading — ten
hardcoded antonym pairs over raw tokens — rather than adding to it. The CLI
supplies `groundedIntentAssessor(index)` from `@coord/code-intelligence` at
`apps/cli/src/worker-operations.ts`, bound to the repository index already
built at the plan's base revision.

The grounded reading resolves each plan's intent *sentence* against real code:
anchor words drawn from every non-test file's path and declared names, weighted
by how rare each word is across the index, and a pair scored on whether the two
intents ground to the same file (`shared`, 0.8), to functions where one calls
the other (`calls`, 0.65), or to files one of which imports the other
(`adjacent`, 0.55) — vetoed unless the two sentences share a content lemma.

Paths that do not supply an assessor are unchanged and keep the legacy reading.

## 2. The known numbers

| | Value |
| --- | --- |
| Held-out precision | **70%** |
| Held-out recall | 58% |
| The bar it was supposed to clear | **80%** |
| Oracle ceiling for its class of rule, same corpus | **75%** |
| Development-half precision / recall | 100% / 100% |
| Grounding recall floor, hallucinated-declaration corpus | 93% reach the right file |

Two of those deserve stating plainly rather than being read off a table.

**70% precision means it is wrong about three firings in ten.** That is
measured on 10 firings over 71 held-out pairs, so the interval around it is
wide — roughly 40% to 89%. The number is not precise enough to certify 80%, and
it is not precise enough to rule it out either.

**The 75% ceiling is the more important one.** It is what the *best possible*
rule over this signal's relation vocabulary achieves on that corpus, computed
by an oracle that has already seen every label. No choice of weights,
thresholds or veto reaches 80% there. So the signal is not merely untuned — on
the only corpus that can currently measure it, the bar is out of reach, and the
reason is a fixture defect rather than the signal (section 4).

## 3. Why switching it on anyway is survivable

**It is advisory, and advisory evidence cannot schedule anything.**
`ConflictDetector.assess` computes a separate structural subtotal and reads the
disposition thresholds against *that*. Intent evidence is scored, reported in
the evidence list, and included in the headline `score` — but excluded from the
number the disposition is computed from. The most it can do is lift a pair from
`concurrent` to `concurrent_with_notification`, which asks a human to look and
costs no parallelism.

It therefore **cannot reach `sequence` or `block`**, whatever it scores, even
at probability 1. That is enforced in `assess` rather than trusted to the
implementation passed in, and pinned by
`services/coordinator/src/conflict-detector.test.ts` — "an injected intent
assessor is advisory and cannot sequence or block". **If that guard is ever
removed, this signal must come out with it.**

This is the same scoping the 2026-07-31 audit installed after finding that the
old intent signal *could* silently carry a pair across a threshold. That bug
cost real parallelism: measured on the team-queue runs, the shipped signal
fired four times and was wrong four times.

**There is a kill switch.** `COORD_DISABLE_INTENT_GROUNDING=1` returns
arbitration to producing no grounded intent evidence at all, without a deploy.

## 3a. The independence finding

The same grounding produces a second, opposite verdict that used to be thrown
away: **both intents resolved to real modules, and the repository holds nothing
joining them** — not the same file, no call either way, no import either way.

This is not the same as the signal being quiet. Quiet covers two different
situations, and only one of them is a judgment:

| | Held-out pairs | Correct |
| --- | --- | --- |
| **No opinion** — at least one intent grounded to nothing | 18 | not a judgment |
| **Independent** — both grounded, nothing connects them | **41** | **41 (100%)** |
| Linked, but the shared-word veto suppressed the firing | 2 | — |

41 for 41, with 11 for 11 on the development half as well: 52 findings, no
false clears. A 95% Wilson interval on 41/41 has a lower bound near **91%**.

Two cautions on that, because it is a better number than the signal's positive
calls and could easily be over-read:

- **41 pairs is still small**, and they are mostly easy — a webhook task
  against an audit task really is obviously unrelated. The hard cases
  concentrate in the pairs it declines or fires on, not here.
- **It is a claim about the base revision only.** Two modules with nothing
  between them today can be joined by the very changes being arbitrated. That
  is precisely why the finding is given almost no power.

### What it is allowed to do

Almost nothing, deliberately:

- It is recorded as `intent_independent` evidence at **score zero**, so it
  contributes to neither the reported score nor the scheduling subtotal.
- It **withholds the notification bump** that other advisory evidence would
  otherwise add to a pair already scheduled as `concurrent`. There is no point
  asking a human to check a pair the coordinator just resolved to two
  unconnected modules.
- It **cannot clear a pair that structural evidence flagged.** If two plans
  name the same file, they are sequenced regardless. Clearing on structural
  overlap is exactly the override the advisory split exists to prevent, and a
  reading measured on 41 pairs is nowhere near strong enough for it.
- It **never creates an assessment on its own.** Assessments are persisted as
  conflict records and traced as `conflict_detected`; a pair just judged
  unrelated must not land there, or it would swamp the table with
  non-conflicts and corrupt the `conflictsDetected` metric benchmarks read. So
  independence rides along in an assessment that exists for other reasons and
  is silent otherwise.

### Honest note on what changed

On today's code this changes **no scheduling decision at all**. The only
advisory producer is the intent signal itself, and "these conflict" and "these
are independent" are mutually exclusive verdicts from it — so the bump it
withholds is one that could not have been raised. A pair judged independent
already ran freely, because a pair with no evidence produces no assessment.

What actually changed is that the finding is now *expressible and recorded*:
an admission audit trail can distinguish "the coordinator resolved both intents
and found nothing joining the modules" from "the coordinator had no idea", which
were the same silence before. The suppression rule is in place and tested so
that it behaves correctly the moment a second advisory producer exists.

Claiming this as a scheduling improvement would be overstating it. It is
observability now, and a correct rule waiting for a case to apply to.

## 4. What is actually still owed

A live run of `team-queue-wired` — the fixture correction in
`docs/benchmarks/intent-grounding.md` section 13 — and an evaluation of this
signal against it.

The reason that run is the open item, rather than more tuning: on the recorded
`team-queue` corpus, all three held-out false positives come from
`task_rounding`, whose band assigns it `src/format/money.js` while the seed
never imports that module. With no edge into the caller there was nothing there
to own, so every agent implemented rounding inside `orderTotal` instead. The
labels are right — the recorded changesets confirm the pairs did not collide —
and the fixture is wrong. `team-queue-wired` fixes it by giving `orderTotal` a
rounding helper that `money.js` owns, so all three partial-band modules are
genuinely imported and called by the caller.

**That run has not happened; it is paused on compute.** Until it does:

- The signal's real precision at realistic scale is **unknown**.
- 70% is the best available estimate and comes from a corpus with a known
  defect that biases *against* the signal on three pairs and tells us nothing
  about how it behaves on a well-formed one.
- Nothing here should be cited as validation. It is a measurement of a
  signal on a fixture that does not implement its own design.

To run it once compute is available:

```powershell
node apps/worker/scripts/team-queue-wired-verify.mjs
```

```powershell
node apps/worker/scripts/team-queue-experiment.mjs --scenario=team-queue-wired --arm=uncoordinated --workers=5 --out=docs/benchmarks/data/team-queue-wired
```

```powershell
node apps/worker/scripts/team-queue-experiment.mjs --scenario=team-queue-wired --arm=coordinated --workers=5 --out=docs/benchmarks/data/team-queue-wired
```

Both arms need `COORD_AGENT_CMD` naming the agent executable, exactly like the
live benchmark. The uncoordinated arm is what supplies observed contention —
which pairs actually collided — and is the check on the designed labels; the
first round of this work could only compare against it on five of ten tasks,
because the other five produced no changeset.

Then evaluate with `intent-grounding-eval.mjs` against the new runs. Note that
the registered agent-id split in `apps/worker/scripts/intent-holdout.mjs`
applies to `team-queue-wired` unchanged, because task ids and agent assignment
are identical — so the held-out half stays held out.

One caution for whoever does it: the recorded `team-queue` corpus has been read
in full, twice. Its numbers are settled and must not be re-scored against the
corrected seed — `assertRegisteredSeed` blocks exactly that. The new runs are a
new measurement, and the honest comparison is between them and the 70%/75%
recorded here, not between them and a re-scored version of the old corpus.

## 5. What would justify taking it back out

- The `team-queue-wired` run measures precision materially below 70%.
- Operators report the extra `concurrent_with_notification` dispositions are
  noise rather than useful prompts to look.
- The advisory guard in `assess` is ever removed or weakened, in which case
  this must be removed in the same change.

## 6. Honest summary

A signal that fires correctly 7 times in 10 has been switched on, in a position
where being wrong costs a human glancing at a pair of tasks and nothing else.
That is a reasonable trade to make early. It is not a validated feature, it did
not clear the bar set for it, and the run that would settle the question is
still outstanding.
