# The Grounded Intent-Conflict Signal

**Verdict: not wired into scheduling, and the line of work is closed.** An
intent signal grounded against the repository index — rather than against the
other task's prose — was built and measured. On the held-out half it scores
70% precision at 58% recall, against an 80% bar.

A second round then went finer, replacing file adjacency with function-call
reachability through a call graph added to the index. That produced the result
that settles it: the **oracle ceiling** over this relation vocabulary is 75%
precision on the held-out half (section 11). No weights, thresholds or veto
setting reach 80% — not even ones chosen with the answers in hand. The
remaining gap is one scenario task implemented outside the module its label
bands it in, and closing it needs a corpus that does not exist and cannot be
constructed from what is recorded (section 12).

That fixture defect has been corrected for future runs — as a sibling
scenario, leaving the recorded one byte-identical and pinned, because
re-scoring the old corpus against a new tree would manufacture the result
rather than measure it (section 13). No number in this document changes.

Sections 1–7 were written and committed *before* the held-out half was read;
section 8 onward was appended afterwards. That ordering is the point of the
document, and `git log docs/benchmarks/intent-grounding.md` is what makes it
checkable rather than merely asserted.

Two amendments were made to section 6 after the held-out read, and neither
touches anything the verdict rests on: the recall-floor table gained a
breakdown by whether the plan declared a file that exists. That is a different
corpus, a different repository, and carries no conflict labels at all — it
cannot be tuned against, which is why it was safe to refine. The frozen
parameter and the decision rule are exactly as committed; `git diff` across the
two commits shows the whole of what changed.

## 1. What the previous result said was needed

`intent-signal.md` records a text-only intent signal that failed honestly. Its
own diagnosis:

> A signal that clears the bar on this label has to distinguish "changes the
> total" from "changes an input to the total", which is a claim about the
> repository and not about the sentence.

That signal reads English correctly — 96% recall at 0.83 median cosine over
forty real agent phrasings of one task — and still scored 0% recall on
held-out pairs, with its single highest-scoring pair being a non-conflict. Two
tasks that both change what a customer pays are maximally similar as sentences
and perfectly independent as code when they own different modules. Module
ownership is not a property of a sentence, so no operating point on
sentence-to-sentence similarity separates those classes.

This is the attempt at the thing that diagnosis pointed to.

## 2. Design

`services/code-intelligence/src/intent-grounding.ts`, following the pattern in
`plan-grounding.ts` one step earlier in the pipeline. Plan grounding resolves
what an agent *declares* against the repository index, so two plans that
misname the same real function collide on the referent. This resolves what an
agent *says it wants* against the same index.

**Anchors.** Every non-test file in the index gets a bag of words it answers
to: its path segments and the names it declares, split on camelCase and
snake_case, filtered through the same generic-token list plan grounding uses
(`get`, `calculate`, `handle`, …), and lemmatized so "orders" and "order" are
one word.

Test files are excluded. `test/total.test.js` carries the same vocabulary as
`src/pricing/total.js`, so leaving it in makes every grounding land on two
files for one reason and inflates every overlap count by the same factor.

**Weights.** Each anchor word is weighted `ln(files / files carrying it)`. A
word every file answers to weighs exactly nothing and a word one file answers
to weighs the most. This is why there is no hand-written list of
uninformative path segments: `src` appears in every path and scores zero on
its own arithmetic.

**Grounding.** An intent's *repository vocabulary* is the content lemmas of its
prose that name something in the index at all. A file's score is the share of
that vocabulary, by weight, that the file accounts for. Files at or above
`targetFloor` become the intent's targets, at most three.

Normalising by the sentence rather than symmetrically was forced by the
development half. The index records every variable declaration, locals
included, so `src/pricing/total.js` answers to `line`, `discount` and `with`
from inside `orderTotal`'s body as well as to `order` and `total` from its
name. Any denominator containing the file's own vocabulary charges a module
for being busy, and the busy module is the one everything contends on: under a
symmetric Jaccard, `task_card_surcharge` — whose every repository word is a
word in `orderTotal`'s name — grounded to nothing at all.

**Pair scoring.** Two relations, in descending strength:

- `shared` (0.8) — both intents ground to the same file.
- `adjacent` (0.55) — one's target imports the other's, per the index's
  dependency edges.

Lexical corroboration is a **veto, not evidence**: a pair scores zero unless
the two intents share a content lemma, or two lemmas WordNet puts in one
synset. This is the half a human can read in an audit trail — "these two were
flagged because they both say `charge`" is a claim a reviewer can disagree
with. WordNet antonymy adds 0.1 when present but is not required: the intents
that collide hardest in practice both say "add".

Declared files are never read. That is deliberate — declarations are what the
structural evidence classes already use, and the question here is what can be
recovered when they are missing, invented, or wrong.

Everything is static against the index. No model call, no embedding, nothing
an audit trail cannot replay.

## 3. The split

Unchanged from `apps/worker/scripts/intent-holdout.mjs`, reused deliberately.
It was registered before the *previous* intent signal was written, which makes
it older than this one too, and re-drawing it now would throw away the only
property that makes held-out numbers worth anything.

Development is `codex-a`/`codex-b`/`codex-c`; held out is `codex-d`/`codex-e`;
a pair is held out if either task is. Labels are the scenario's own
`TEAM_QUEUE_TRUE_CONFLICTS`, pre-registered before any run happened.

Corpus: the three committed team-queue runs. `team-queue-coordinated-ab-legacy`
is a later untracked run and is excluded, so these pair counts stay comparable
with the ones in `intent-signal.md`.

**One disclosure.** Before the split filter was applied, a corpus dump printed
the initial plan intents for all ten tasks, so two held-out intent strings were
seen once. No parameter below was chosen from them — `targetFloor` is fixed by
two development-half cases named explicitly, and the relation weights are not
classifier boundaries. It is recorded because it is true and because a reader
should discount accordingly.

## 4. The operating point, frozen

One tuned parameter: `targetFloor = 0.65`. It has to sit above the highest
*wrong* grounding the development half produces and below the lowest right
one. Both edges are real cases from that half, and both are homonyms rather
than noise:

| | Case | Score |
| --- | --- | --- |
| Highest wrong | `task_webhook_retry` → `src/pricing/total.js` — "preserving the existing synchronous **delivery** API", and `total.js` declares `const DELIVERY` | 0.500 |
| Next wrong | pricing intents → `src/pricing/discount.js` — `orderTotal` has a local named `discounted`, so the caller answers to "discount" | 0.550 |
| Lowest right | `task_handling_fee` → `src/pricing/total.js` — names five things in the repository, four of them in the file it means, because it lists what it must not break | 0.773 |

0.65 is the middle of (0.550, 0.773] rather than either edge. Reading a
boundary off the edge of a forty-pair sample is fitting the sample; the honest
claim the development half supports is that the classes separate somewhere in
that interval, and the midpoint is what that claim implies.

The relation weights (0.8 / 0.55 / +0.1) are strengths for a downstream
consumer to weigh, not a boundary — `fireThreshold` sits below both so that
the two relations are the two ways to fire.

## 5. Development half

40 pairs pooled over 3 runs, 15 positive.

| Ground truth | Pairs | Pos | Fired | TP | FP | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| designed | 40 | 15 | 15 | 15 | 0 | **100%** | **100%** |
| observed, uncoordinated arm | 15 | 3 | 6 | 3 | 3 | 50% | 100% |
| observed, both tasks patched | 6 | 3 | 3 | 3 | 0 | 100% | 100% |

The middle row needs its qualification stated rather than buried. Observed
truth is derived from which files each task's changeset touched, and in the
uncoordinated run only five of ten tasks produced a changeset at all —
`task_card_surcharge` produced none. All three of its "false positives" are
pairs with a task that contended with nothing because it never emitted
anything. Restricted to pairs where both tasks actually patched something,
which is the only population observed truth is defined over, the signal is
3 for 3. The eval script reports all three rows so neither reading can be
quoted without the other.

Every development firing is `shared` on `src/pricing/total.js`. The
development half contains no positive pair spanning two modules, so **it cannot
test the `adjacent` relation at all** — it can only show, as it does, that
adjacency costs nothing there, because no notification or audit module has an
edge into pricing.

## 6. Recall floor: does the mechanism find the module at all?

`apps/worker/scripts/intent-grounding-recall-floor.mjs`, over the tracked
`docs/benchmarks/data/grounding/*replan-substitution*` runs — 67 real agent
intents for one request, `task_checkout_fee`, against a *different*
repository (the `live-checkout-trio` seed). Every pairing is the same work
described twice, so there are no negatives and this measures recall only.
Nothing was tuned against it.

This is the recorded hallucination corpus, which makes it the interesting one
for grounding specifically. Those agents declared `src/checkout.js` and
`calculateTotal`; the repository contains neither, and `orderTotal` in
`src/pricing/total.js` is what they meant.

| | |
| --- | --- |
| Distinct agent intents | 67 |
| Plans declaring a file that exists | 27 (40%) |
| Intents that ground to some file | 62 (93%) |
| Intents whose top target is `src/pricing/total.js` | 59 (88%) |
| Same-work pairs sharing a target | 1891 of 2211 (86%) |

Of the rest, 5 ground nowhere and 3 reach `src/format/summary.js`.

Split by whether the plan declared a file that exists — which is the split that
matters, because the subgroup that did not is the one structural evidence has
nothing to arbitrate on:

| Subgroup | n | Grounded | Top target is `total.js` |
| --- | --- | --- | --- |
| declared a real file | 27 | 81% | 81% |
| declared none that exist | 40 | **100%** | **93%** |

The signal is at its best precisely where the declarations are useless. For
those 40 plans the coordinator has no real footprint to arbitrate on at all,
and from the sentence alone grounding reaches the file the agent meant but
never named, 93% of the time. That is the gap this signal exists to cover,
measured on a repository the floor was not chosen against.

It is a floor, not a validation. "Two phrasings of one task agree" is a much
easier question than "two different tasks collide", and the previous signal
passed its own floor at 96% and then failed completely on the hard question.

## 7. Pre-registered decision rule

Written before the held-out half was read.

1. The **primary** candidate is the signal as specified above, both relations
   live. Identity alone is silent by construction on every pair whose tasks own
   different modules, which is precisely the population the previous negative
   result stumbled on, so shipping identity-only would guarantee the same nil
   return.
2. The **secondary** candidate, reported alongside, is `shared` targets only.
3. The wiring decision is made on the **primary**, at whatever precision it
   reports, and is not switched to the secondary if the secondary happens to
   score better. Choosing the winner after seeing both is how a held-out set
   stops being one.
4. The bar is roughly **80% precision** on held-out data. Below it, nothing is
   wired into scheduling weight and the result is written up as a negative.
5. Zero firings is not a pass. A signal with nothing to say does not clear a
   precision bar; it has no precision.

<!--
Everything above this line was committed before the held-out half was read,
except the subgroup breakdown in section 6 — see the note under the verdict.
-->


## 8. Held-out half, read once

71 pairs pooled over 3 runs, 12 positive.

| Rule | Fired | TP | FP | FN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| **primary** (shared + adjacent) | 10 | 7 | 3 | 5 | **70%** | **58%** |
| secondary (shared only) | 4 | 3 | 1 | 9 | 75% | 25% |

**Verdict: 70% precision does not clear the 80% bar. Nothing is wired into
scheduling.** Per rule 3 of the pre-registration, the decision is made on the
primary and is not switched to the secondary, which is also under the bar and
which buys its extra 5 points with a third of the recall.

The sample deserves saying out loud: 7 correct out of 10 firings. A 95%
interval on that runs from roughly 40% to 89%. The data cannot certify 80%,
and cannot rule it out either. "Too few firings to certify" is a reason not to
wire something into scheduling, not a reason to round up.

For comparison, on the same split: the shipped `intent_conflict` scored 60%
precision at 25% recall, and the text-only replacement in `intent-signal.md`
fired zero times.

### Every false positive is one task

All three involve `task_rounding`, and all three are the same fact:

```
FP task_loyalty_tier + task_rounding [partial/partial] shared   on src/pricing/total.js
FP task_loyalty_tier + task_rounding [partial/partial] adjacent on total.js -> discount.js
FP task_rounding     + task_zero_rated_goods [partial/partial] adjacent on total.js -> tax.js
```

`task_rounding` is designed into the partial band, which the scenario defines
as tasks that "each own a different pricing module that `total.js` imports".
That definition holds for `task_loyalty_tier` (`discount.js`) and
`task_zero_rated_goods` (`tax.js`) and does not hold for `task_rounding`: the
module it would own is `src/format/money.js`, and `total.js` does not import
it. It is the odd one out in the fixture before any agent touches it.

What the agents did completes the picture. In every run where the task appears
they planned it into `src/pricing/total.js`, wrote intent prose to match —
"whole-pence rounding at the final order-total boundary" — and patched
`total.js` when they got there. So grounding puts it on
`total.js`, which is exactly where the work went, and the label puts it in a
band that says it does not contend with other partial-band tasks. Observed
truth agrees with the label: in the uncoordinated run `task_rounding` patched
`total.js` and `task_loyalty_tier` patched `discount.js`, and they did not
collide. These are real false positives, not label artefacts.

But the symmetry is what matters, and it says the development half was
flattering. The *same* grounding of `task_rounding` onto `total.js` produced 3
true positives on the development half, where its pairs with deep-band tasks
are labelled conflicts. One fact, scored as correct on one side of the split
and incorrect on the other, with nothing about the signal differing between
them. A development half that contains `task_rounding` paired only with deep
tasks cannot show this, and it did not.

### Every miss is the other task

All five involve `task_zero_rated_goods`, in two distinct ways.

Three are a grounding failure. Its `live3` phrasing — "Disable tax calculation
only when every order line represents a digital good, while preserving the
standard tax rate for physical and mixed orders" — names five things in the
repository, and `src/pricing/tax.js` accounts for only three of them.
"Order" and "line" are anchors of `orderTotal`'s body, so the sentence's own
scene-setting dilutes it below 0.65 and it grounds nowhere at all. Its
terser phrasing in the uncoordinated run grounds to `tax.js` at 0.741, barely
clearing. The floor is doing what it was set to do and this intent sits on the
wrong side of it.

Two are the corroboration veto. `task_card_surcharge` + `task_zero_rated_goods`
and `task_free_delivery` + `task_zero_rated_goods` both ground correctly —
`total.js` and `tax.js`, with the import edge between them — and are dropped
because the two sentences share no content lemma. One task talks about cards
and surcharges, the other about tax and digital goods; they collide in the
code and agree on no word.

That veto was carried over from the text-only signal, where it was the
precision safeguard. Here the evidence is the grounding, and requiring a
lexical agreement on top costs recall on exactly the cross-module pairs
adjacency was added to catch. Whether removing it would help is not something
this measurement can answer, because answering it means reading the held-out
half a second time with a changed rule. It is written down as the first thing
to try, against a corpus that does not yet exist.

### Observed truth on the held-out half

| Ground truth | Pairs | Pos | Fired | TP | FP | Precision |
| --- | --- | --- | --- | --- | --- | --- |
| observed | 30 | 0 | 6 | 0 | 6 | 0% |
| observed, both tasks patched | 4 | 0 | 3 | 0 | 3 | 0% |

Reported because it is what the arm says, and it is bad. Two things bound how
much it can mean. The held-out positive set is entirely deep↔partial pairs,
and *none* of them contended at file level in the one uncoordinated run
available — the deep tasks landed in `total.js` and the partial tasks in the
modules it imports, so a file-level truth cannot see the band at all. And only
`task_loyalty_tier` of the four held-out tasks produced a changeset, leaving a
four-pair denominator with zero positives in it, against which no signal that
ever fires can score above zero.

So this row does not distinguish this signal from a better one. What it does
establish is that the designed label's claim for the deep↔partial band — that
those pairs cannot both land unexamined — is a claim about reasoning over a
stale total, not about merge conflicts, and no evidence in this repository
confirms it independently of the scenario's own say-so.

## 9. What is and is not wired in

- **Not wired in:** everything in `services/code-intelligence/src/intent-grounding.ts`.
  No service imports it. It is reachable only from the two evaluation scripts.
- **Unchanged:** `ConflictDetector.analyzeIntent` still produces
  `intent_conflict` from its ten hardcoded antonym pairs, still advisory, still
  unable to reach `sequence` or `block`. Replacing it with this would improve
  an audit-trail note that scheduling does not act on. It is left alone,
  because "better than a thing measured at 60% precision" is not the bar, and
  a 70% signal wired in anywhere is a 70% signal someone will later cite as
  validated.
- **Unchanged:** the advisory-evidence safety scoping from `intent-signal.md`.
  Nothing here needed it, because nothing here is wired.

## 10. What this changes about the conclusion in `intent-signal.md`

That document concluded intent prose was the wrong input, and that a signal
worth scheduling on would combine the grounded symbol graph with intent. This
tested that and the conclusion survives in a weakened form.

Grounding is not the problem. Given a sentence, it finds the right module, and
it does so best on exactly the plans whose declarations are fiction: of the 40
recorded intents whose declared file does not exist, 100% ground somewhere and
93% ground to the file the agent meant. That is a real capability the previous
signal did not have, and it is measured on data nothing was tuned against.

What grounding cannot supply is the *relation*. Once both tasks are on real
modules, deciding whether they can both land needs to distinguish "rewrites
the caller" from "rewrites something the caller reads", and the two relations
available from a repository index — same file, import edge — do not draw that
line. Same-file is too narrow: it is silent on the entire held-out positive
band by construction. Import-edge is too broad: it cannot tell
`task_loyalty_tier` + `task_handling_fee` (a conflict) from
`task_loyalty_tier` + `task_rounding` (not one), because the edge
`total.js -> discount.js` is the same edge in both.

The distinction those two pairs turn on is whether the caller-side task is
rewriting the *combination* of inputs or wrapping the *result* of it. That is
visible in a diff and invisible in an import graph, which is a claim about what
the index records, not about intent. The next thing to try is a finer relation
— symbol-level reach through the call graph rather than file-level import
edges — and a corpus where the partial band is implemented where it was
designed to be, so that one task's placement cannot swing six pairs.

That was tried. Section 11.

## 11. Symbol-level call reach, and the ceiling it runs into

### What was built

The index now records a call graph. `IndexedFile.symbolCalls` attributes every
call expression to the declared symbol whose body contains it, so
`src/pricing/total.js#orderTotal -> discountRate` is a fact the index states
rather than one a reader infers from "total.js mentions discountRate
somewhere". Grounded targets narrowed correspondingly: an `IntentTarget` now
carries the symbols of its file that the intent's own vocabulary reaches, not
just the file.

On top of those, a new relation tier `calls` sits between `shared` and
`adjacent`: it fires when a function one intent reaches calls a function the
other reaches. It is strictly narrower than import adjacency — two files can be
neighbours while the two functions in question have nothing to do with each
other.

### It changes nothing on the development half, and could not have

40 pairs, 15 of 15, 100% precision and recall — identical to before, because
the development half contains **no `calls` pair at all**:

| Tier | Conflicts | Non-conflicts |
| --- | --- | --- |
| `shared` / corroborated | 15 | 0 |
| `none` / corroborated | 0 | 11 |
| `none` / bare | 0 | 14 |

Every development positive is two tasks on `src/pricing/total.js`. The half
that chose `targetFloor` has never contained a single cross-module conflict, so
every parameter governing the cross-module relation — the call tier, the
adjacency tier, the corroboration veto — was set blind, and still is. That is a
sharper statement of the "development was flattering" finding in section 8, and
it is a property of the split rather than of the signal.

### The ceiling: no rule over these relations reaches the bar

Rather than re-measure a changed rule on a held-out half already read once —
which would be tuning on it — `apps/worker/scripts/intent-relation-inputs.mjs`
computes the **oracle ceiling**: for each distinct structural input, an oracle
that has already seen every label decides whether to fire, and decides
correctly. No real rule can beat it. It is a bound computed *with* the labels,
not an operating point, and its only use is the negative one.

Bucketed by what a rule actually consumes — relation tier and whether the pair
is lexically corroborated — on the held-out half:

| Tier | Conflicts | Non-conflicts | Purity |
| --- | --- | --- | --- |
| `shared` / corroborated | 3 | 1 | 75% |
| `calls` / corroborated | 4 | 2 | 67% |
| `calls` / bare | 2 | 0 | 100% |
| `none` / corroborated | 3 | 15 | 83% |
| `none` / bare | 0 | 41 | 100% |

| | TP | FP | FN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| Oracle ceiling, held-out | 9 | 3 | 3 | **75%** | **75%** |
| The shipped rule, held-out | 7 | 3 | 5 | 70% | 58% |

**75% is the ceiling. The 80% bar is unreachable on this corpus by any rule
over this relation vocabulary** — any weights, any thresholds, any veto
setting, including settings chosen with the answers in hand. This is the
result that closes the line of work rather than another failed attempt at it.

Two tiers carry both labels and account for the whole shortfall:
`shared`/corroborated holds `task_loyalty_tier` + `task_rounding`, and
`calls`/corroborated holds `task_rounding` + `task_zero_rated_goods`. Both are
`task_rounding`, for the reason section 8 set out: it grounds to `total.js`
because that is where every agent put it, while the label bands it elsewhere.

### The one thing the ceiling says is fixable

`calls`/bare is 2 conflicts and 0 non-conflicts. Those are the two pairs the
corroboration veto drops — `task_card_surcharge` and `task_free_delivery`
against `task_zero_rated_goods`, which reach `orderTotal` and `taxFor`
respectively, have the call edge between them, and share no content lemma.
Removing the veto for the `calls` tier would take the signal from 70%/58% to
the 75%/75% ceiling.

**That change has not been made.** The evidence for it is entirely held-out:
the development half has no `calls` pair to argue from, so making the change
now would be fitting the rule to the data that judges it, and it would still
land 5 points under the bar. It is recorded as indicated-but-unvalidated, and
`DEFAULT_GROUNDED_INTENT_OPTIONS` is unchanged.

### A caveat on a more optimistic number

The same ceiling computed over the *full* structural input — both sides'
grounded files, their reached symbols, and every edge between them — is 92%
precision at 92% recall on held-out. That number should not be believed. Those
inputs are fine enough that 36% of pairs have one that occurs exactly once, at
a mean multiplicity of 1.76, so the oracle is substantially looking pairs up
rather than generalising. It is a valid upper bound and almost no evidence.
What it does establish is that the finer representation is not *information*
-starved; whether the separation it finds would generalise is a question this
corpus is too small to ask.

## 12. Why there is no second held-out set

`apps/worker/scripts/intent-corpus-audit.mjs` enumerates every recorded corpus
against the three things a precision measurement needs: agent-written intent
prose, at least three distinct tasks so that pairs exist, and both labels.

| Corpus | Files | Tasks | Agent intents | Labels | Usable |
| --- | --- | --- | --- | --- | --- |
| `live-checkout` | 15 | 2 | 0 | all-positive by design | no |
| `live-checkout-trio` | 75 | 3 | 67 | all-positive by design | no |
| `live-pricing` | 1 | 0 | 0 | aggregate metrics only | no |
| `team-queue` | 3 | 10 | 74 | pre-registered, 12 / 33 | **yes — and read** |

The checkout scenarios fail on the third requirement for a reason that is not
an accident: they were *built* uniformly contended, which was correct for
measuring replan cost and makes them incapable of producing a false positive.
`.coordinator/coordination.db` holds five distinct ad-hoc tasks — READMEs and a
chess demo — with no conflict labels.

So the answer to "construct a fresh held-out set" is that one cannot be
constructed from what exists. Writing the intent prose myself would measure
the author rather than the signal, and it is the prose, not the labels, that
must come from somewhere else.

What a usable corpus needs, concretely: three or more agent-written intents per
run over a scenario with a genuine independent band, and — the part team-queue
got wrong — every partial-band task owning a module the caller actually reads.
`task_rounding` alone accounts for all three held-out false positives, of eight
errors in total; the other five are `task_zero_rated_goods` and are unrelated
to banding. That requires live agent runs, which is the single blocker;
everything else in this document was computed without any.

## 13. The fixture defect, and what was done about it

### It is a fixture defect, not a mislabelling

The tempting correction is to re-band `task_rounding` as deep, which would turn
all three false positives into true positives and report 100% precision. That
number would be manufactured. `task_rounding` was identified *by inspecting
which pairs the signal got wrong*, and relabelling those same pairs is the
circularity the held-out method exists to prevent.

The recorded data settles it independently. In the uncoordinated arm
`task_rounding` patched `src/pricing/total.js` and `task_loyalty_tier` patched
`src/pricing/discount.js`. They did not collide. The label calls that pair a
non-conflict and observed behaviour agrees, so the label is right and the three
false positives are real.

What is wrong is one level down. The scenario documents its partial band as
three tasks that "each own a different pricing module that `total.js`
imports":

| Task | Module | Imported by `total.js`? |
| --- | --- | --- |
| `task_loyalty_tier` | `src/pricing/discount.js` | yes |
| `task_zero_rated_goods` | `src/pricing/tax.js` | yes |
| `task_rounding` | `src/format/money.js` | **no — nothing imports it** |

With no edge into the caller there is nothing in `money.js` for a rounding
task to own, so every recorded agent implemented rounding inside `orderTotal`
instead. Grounding then correctly followed them to `total.js`, and the pairs
that followed were correctly labelled non-conflicts. Every part of the chain
behaved properly except the tree.

### The correction

`apps/worker/scripts/team-queue-wired-scenario.mjs`, a sibling rather than an
edit. `team-queue` stays byte-identical, because the numbers above are only
reproducible while it does — `assertRegisteredSeed` in `intent-holdout.mjs`
now pins its seed by SHA-256, and both evaluation scripts refuse to run
against a changed one rather than silently re-scoring the old corpus against a
new tree.

`team-queue-wired` is the same ten tasks, ids, objectives and agent assignment
— so the registered split applies to it unchanged — over a seed differing in
three files. `src/format/money.js` gains a `roundMoney` helper that rounds to
whole pounds at the base revision, which is the defect `task_rounding` exists
to fix; `orderTotal` imports and applies it; and `test/money.test.js` covers
it without pinning the number of decimal places, since changing that is the
work. `team-queue-experiment.mjs` takes `--scenario=team-queue-wired`, with
the recorded scenario still the default so that repeating a past experiment
does not quietly change what it measures.

`apps/worker/scripts/team-queue-wired-verify.mjs` checks the fixture before a
live run is spent on it: the seeded tree passes its own `node --test`, and
every partial-band module is both imported and called by the order total.

```
task_loyalty_tier        src/pricing/discount.js    imported, orderTotal -> discountRate
task_zero_rated_goods    src/pricing/tax.js         imported, orderTotal -> taxFor
task_rounding            src/format/money.js        imported, orderTotal -> roundMoney
```

### What this does and does not buy

It produces **no new numbers**. The recorded intents were written by agents
looking at the old tree; grounding them against the corrected one would score
sentences against a repository their authors never saw, which is precisely
what the seed pin now prevents. The held-out result stands at 70% precision
and the ceiling at 75%.

What it buys is that the next live run measures the scenario that was
designed rather than the one that was built. Whether the signal clears 80% on
a fixture whose bands hold is the open question, and it is now a question
someone can answer by spending agent time rather than by relabelling.

## Reproducing

```powershell
npx turbo run build
node apps/worker/scripts/intent-grounding-eval.mjs --split=development docs/benchmarks/data/team-queue/team-queue-co*live3*.json docs/benchmarks/data/team-queue/team-queue-*livelockfix*.json docs/benchmarks/data/team-queue/team-queue-unco*.json
```

```powershell
node apps/worker/scripts/intent-grounding-recall-floor.mjs
```

```powershell
node apps/worker/scripts/intent-relation-inputs.mjs docs/benchmarks/data/team-queue/team-queue-co*live3*.json docs/benchmarks/data/team-queue/team-queue-*livelockfix*.json docs/benchmarks/data/team-queue/team-queue-unco*.json
```

```powershell
node apps/worker/scripts/intent-corpus-audit.mjs
```

`--groundings` prints what each intent grounded to, restricted to the tasks on
the requested side of the split. `--json` writes the per-pair table. The script
refuses to evaluate both halves in one command, and fails loudly if the
scenario's agent assignment drifts from the one the split was registered
against.

No model download and no optional dependency: unlike `intent-signal.md`, this
signal has no embedding stage, so `npx turbo run build` is the whole setup.
