# The Grounded Intent Signal Is Wired In — Now Measured Live, Still Not Certified

**Read this first: the signal described here was switched on *before* the test
that would justify it, not after.** That is a deliberate decision taken with
the numbers below in hand, and this document exists so that nobody later finds
it in the audit trail and assumes it earned its place there.

**As of 2026-08-06 that test has been run.** Eleven live runs against the
corrected `team-queue-wired` fixture put held-out precision at **89%** with a
95% interval of **[63%, 100%]** — better than the 70% recorded here, and still
not enough to certify the 80% bar. Recall got *worse*, at 39% against 58%. The
run is section 4; what it does and does not settle is section 7.

Everything measured on the original corpus is in
`docs/benchmarks/intent-grounding.md`. This page records what is live, what is
known, and what is still owed.

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

These are the numbers from the *original* `team-queue` corpus, which is what
justified the decision at the time. The live `team-queue-wired` measurement
that supersedes them is section 4.

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

## 4. The live `team-queue-wired` run (2026-08-06)

The fixture correction is `docs/benchmarks/intent-grounding.md` section 13. On
the recorded `team-queue` corpus all three held-out false positives come from
`task_rounding`, whose band assigns it `src/format/money.js` while the seed
never imports that module — so every agent implemented rounding inside
`orderTotal` instead, and the signal correctly followed them there and was
scored wrong for it. `team-queue-wired` gives `orderTotal` a rounding helper
that `money.js` owns, so all three partial-band modules are genuinely imported
and called. `team-queue-wired-verify.mjs` confirms that before any run.

**Eleven runs were executed: ten uncoordinated and one coordinated.** Nine
uncoordinated runs (a pilot plus `s1`–`s8`) form the precision corpus; a tenth
(`wired-full`) is an independent contention sample; the coordinated run is a
smoke test of the wired code path and is deliberately *not* pooled into any
precision number.

### 4.1 Precision and recall, held-out split

Pooled over the nine precision runs — 270 pairs, designed (pre-registered)
labels:

| | Value |
| --- | --- |
| Firings | **22** |
| True / false positives | 21 / 1 |
| Precision, firing-level | 95% — 95% CI [78%, 99%] |
| **Precision, run-clustered** | **89% — 95% CI [63%, 100%]** |
| **Recall** | **39% — 95% CI [27%, 52%]** |

**Quote the clustered number.** The 270 pairs are not 270 independent
observations: they are the same 30 task-pairs resampled nine times, so the
firing-level interval is too narrow for the same reason `intent-holdout.mjs`
gives for splitting by agent rather than by run — runs vary the sample, not the
population. Treating each run as the unit of observation is the honest
accounting, and it widens the interval considerably.

Per-run precision was `100% ×8` and `0% ×1`. The whole of the variance is one
run (section 4.4).

Against the bar: 80% now sits *inside* the interval rather than above the point
estimate. That is a real improvement on 70% [40%, 89%] and it is **not** a
pass. [63%, 100%] is consistent with clearing 80% and consistent with failing
it. Note also that the 75% oracle ceiling recorded in section 2 was a property
of the *defective* fixture; exceeding it here is evidence that the fixture
defect was real, not that the signal itself improved.

### 4.2 Recall regressed, and the cause is prose length

Recall fell from 58% to 39%. The mechanism is visible in the evaluator's own
notes. A file's grounding score is `mass(matched) / mass(all intent
vocabulary)` — the denominator is the intent's *entire* repository vocabulary.
When a plan names modules it will explicitly **not** change, that vocabulary
inflates the denominator and sinks the real target below `targetFloor` (0.65):

```
task_zero_rated_goods
  vocabulary: line, order, price, rate, src, standard, tax, total
  note: intent names ... but no file answers to enough of it to clear 0.65
```

That intent *does* name `src/pricing/tax.js`. It also discusses `total.js`,
`test/tax.test.js` and a README rule, spreading its vocabulary across four
files so none clears the floor. It grounds to nothing and loses three designed
positives every run it does this.

This is plausibly an artefact of the model swap rather than of the code:
Opus at high effort writes long, thorough intents that cite neighbouring
modules and justify what they do not touch, and this scoring penalises exactly
that style. It is not established — it is the most likely explanation for a
19-point recall drop that coincided with changing the model.

### 4.3 Observed contention: the held-out split cannot measure it

Against observed truth — which pairs' patches actually touched a common file —
the held-out split reports `pos=0, fired=22, precision=0%`.

**That 0% is an artefact of split composition and must not be cited as a
result.** The three tasks that actually collide (`task_handling_fee`,
`task_free_delivery`, `task_card_surcharge`, all on `src/pricing/total.js`) are
owned by `codex-a/b/c`, every one of them development-half. A held-out pair
requires `codex-d` or `codex-e`. So the held-out split contains **no**
observed-contending pair by construction, and any firing at all scores 0%. More
runs cannot fix this; it is a property of the registered split, not of the
sample.

Scoring the *development* split of `wired-full` gives the first real
observed-truth precision in this work: **1 firing, 1 correct** —
`task_card_surcharge + task_handling_fee`, a `shared` relation on
`src/pricing/total.js`, and those two tasks did collide there. Read it as
proof the measurement works once the split contains real collisions, and as
nothing else: n=1, on the half the thresholds were tuned against.

Getting a trustworthy observed-truth number is an open item (section 6).

### 4.4 What the outlier run actually shows

Run `s3` scored 0% precision and 0% recall. It fired once, on
`task_loyalty_tier + task_rounding` — the same false positive the original
corpus produced — via a `calls` relation `orderTotal -> roundMoney`.

`s3` is **not** a run that erred where others did not. It is a run whose
*correct* firings vanished: all six of its designed positives missed because
both held-out tasks failed to ground usefully, leaving one pre-existing error
as the entire numerator. Its 0% is a denominator artefact.

The root cause of that false positive is internal to grounding and is the same
mechanism as section 4.2. Relation formation flattens every target with no
regard for rank:

```js
const leftFiles = new Set(first.grounding.targets.map((entry) => entry.file));
const callTargets = callEdges(index, reachedSymbols(first.grounding), ...);
```

`task_loyalty_tier` grounds to `discount.js` at 1.000 *and* — because of the
same spilled vocabulary — to `total.js` at 0.667. `orderTotal`, reached only
through that weak secondary target, is then given identical authority to a
1.000 primary, and `orderTotal -> roundMoney` is a real edge. One spilled
vocabulary both sinks true targets and manufactures false ones.

### 4.5 Coordinated smoke test

One coordinated run, 30-minute budget, purely to confirm the newly-wired code
path survives real arbitration. **Its pairs are not pooled into any precision
number** and must not be: the coordinated arm sequences and requeues work, so
its plans are not independent samples of first-arbitration prose.

| | Value |
| --- | --- |
| Tasks integrated | 10/10 |
| Conflict assessments recorded | 25 |
| `intent_conflict` evidence produced | **9** |
| …carrying `advisory: true` | **9 of 9** |
| …carrying anything else | **0** |
| Advisory-only assessments reaching `sequence` / `block` | **0** |
| Dispositions | 24 `block`, 1 `sequence` — all on structural evidence |

The signal ran in a real arbitration, produced evidence, and the guard in
section 3 held: every intent finding was advisory, and nothing scheduled on
one. No `intent_independent` evidence was recorded, which is consistent with
section 3a — independence never creates an assessment of its own, and every
assessment here existed because of structural overlap.

### 4.6 How much this signal is actually needed here

Measured across the ten uncoordinated runs, comparing what the plans
*declared* against what the patches actually did:

| | Count | Caught by declared-file overlap |
| --- | --- | --- |
| Collisions that actually happened | 28 | **28 (100%)** |
| Designed-label positives the signal is scored on | 60 | **0 (0%)** |

Every real collision was between tasks that both declared
`src/pricing/total.js` and both edited it — plain file-level overlap, the
structural detector's easiest case. The intent signal caught none of them that
structural did not already have, and its misses fall on designed-label pairs
that never collided.

So 39% recall costs very little *here*. The honest caveat is why: this corpus
contains no plan whose declarations were missing or fictional, and that is the
only case the signal exists for. Its value is untested rather than disproved,
and the cost of low recall rises with declaration quality falling.

## 5. Deviations from the recorded corpus

This is not an apples-to-apples replication, and four things differ. The first
two were chosen; the second two were forced by the environment.

1. **Claude instead of Codex.** The recorded corpus is Codex. Codex cannot
   execute on this machine — the `codex-windows-sandbox-setup.exe` helper is
   missing, so it can plan but not produce patches, which would have silently
   invalidated everything needing a real changeset.
2. **Opus, `--effort high`**, set through `COORD_AGENT_ARGS` and
   `COORD_AGENT_EFFORT`. Both are recorded in every run artefact's `env` block.
3. **Approvals disabled** — `{version: 1, approvals: {enabled: false}}` on the
   benchmark project. Opus plans declare schema changes; Codex plans did not.
   The default policy gates any such plan and waits up to 24 hours for a human
   while the worker holds its lease for up to 8, which in an unattended
   benchmark is a deadlock: the pilot gated 8 of 10 plans and burned its whole
   budget. Plans are recorded *before* the gate, so the intent corpus is
   unaffected — the pilot still captured all ten first plans.
4. **The harness required repair before it would run at all.** It predated the
   multi-tenant work: `Worker` now requires an `organizationId`, and leasing is
   project-scoped through `authorizeProject`. Nobody had run this harness since
   that landed.

**Tokens are unreported.** The prompt-cli adapter emits no usage line, so every
token counter in these artefacts reads zero. Real cost was incurred and none of
it is measured here. Do not read `tokens=0` as free.

### Run accounting

Ten uncoordinated runs are on disk and nine are pooled for precision. One
further run was **discarded**: its project policy omitted `version: 1`,
`assertProjectPolicy` rejected it, every lease returned 500, and the worker
loop — which correctly treats a 500 as transient — retried 3,895 times for
twenty minutes and produced no plans. No agent tokens were spent. The harness
now validates the policy at boot and aborts after 40 consecutive fruitless
iterations rather than spending a budget on nothing.

Infrastructure was otherwise clean: 10/10 integrated on every pooled run, zero
transport failures on all but the pilot. Three of ten uncoordinated runs ended
with a failing merged tree, which is a finding about last-writer-wins merging
rather than a fault.

## 6. What is still owed

- **A trustworthy observed-contention number.** Blocked on split composition
  (section 4.3), not on compute. Requires scoring the development split
  explicitly, or a corpus where `codex-d`/`codex-e` tasks collide.
- **Fix A — rank-weighted relation scoring.** *Proposed, not implemented.*
  Scale a relation by `min(leftRank, rightRank)` where
  `rank = target.score / topTargetScore`, so evidence inherits the confidence
  of the weakest grounding that produced it. On the observed failure this takes
  `loyalty_tier + rounding` from 0.65 to 0.43 — below the 0.5 fire threshold —
  while every current true positive fires from rank-1.0 targets on both sides
  and is untouched. It can only ever *lower* scores, so it cannot manufacture
  new false positives; the risk is new false negatives, on an axis that is
  already weak.
- **The recall half is deliberately not bundled with it.** Fixing the
  denominator means re-deriving the frozen `targetFloor`, whose justification
  is documented against specific development-half cases. Doing both at once
  makes it impossible to attribute whichever number moves.
- **Neither may be tuned on the held-out split of these runs.** That corpus is
  currently clean holdout and is the only trustworthy measurement available.
  Choose thresholds on `codex-a/b/c`, then measure **once** against held-out.
  Tuning the rank rule against the held-out false positive would destroy the
  only property that makes any of this worth reading.

## 7. What would justify taking it back out

- A measurement puts precision materially below 70%.
- Operators report the extra `concurrent_with_notification` dispositions are
  noise rather than useful prompts to look.
- The advisory guard in `assess` is ever removed or weakened, in which case
  this must be removed in the same change.

## 8. Honest summary

The run this document called for has happened. On the corrected fixture the
signal fires correctly about nine times in ten, up from seven, with an interval
[63%, 100%] that neither certifies the 80% bar nor rules it out. Recall fell to
39%, for a reason that is understood and probably an artefact of the model
swap. The single recurring false positive has a diagnosed root cause and a
bounded fix, which is proposed and not implemented.

Measured against what it costs: every collision that actually happened in these
runs was caught by structural file overlap without help, and the guard that
keeps intent evidence advisory held in a live coordinated arbitration — nine
findings, all advisory, none scheduling anything.

It is better than it was, it is measured now rather than assumed, and it is
still not a validated feature. It should stay advisory.
