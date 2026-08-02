# The Grounded Intent-Conflict Signal

**Status at the time this section was committed: the held-out half has not
been read.** Everything below the pre-registration line was written first, and
the results section was appended afterwards in a separate commit. That
ordering is the point of the document; `git log docs/benchmarks/intent-grounding.md`
is what makes it checkable.

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

The middle row is the one worth reading twice. For 60% of these plans the
declared file does not exist, so the structural evidence classes have nothing
to arbitrate on — and from the sentence alone, grounding reaches the file the
agent never named, in 88% of cases. That is the gap this signal exists to
cover, measured on a repository the floor was not chosen against.

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

<!-- Everything above this line was committed before the held-out half was read. -->

## 8. Held-out half

*To be appended.*

## Reproducing

```powershell
npx turbo run build
node apps/worker/scripts/intent-grounding-eval.mjs --split=development docs/benchmarks/data/team-queue/team-queue-co*live3*.json docs/benchmarks/data/team-queue/team-queue-*livelockfix*.json docs/benchmarks/data/team-queue/team-queue-unco*.json
```

```powershell
node apps/worker/scripts/intent-grounding-recall-floor.mjs
```

`--groundings` prints what each intent grounded to, restricted to the tasks on
the requested side of the split. `--json` writes the per-pair table. The script
refuses to evaluate both halves in one command, and fails loudly if the
scenario's agent assignment drifts from the one the split was registered
against.

No model download and no optional dependency: unlike `intent-signal.md`, this
signal has no embedding stage, so `npx turbo run build` is the whole setup.
