# The Intent-Level Conflict Signal

**Verdict: not wired into scheduling.** A lemmatized, WordNet-corroborated,
embedding-scored replacement for `intent_conflict` was built and measured. It
fired zero times on the held-out half of the corpus, so its precision there is
undefined and it cannot be reported as clearing the 80% bar. The shipped
signal's contribution to scheduling has been removed regardless, because that
contribution was a bug.

Two separate things are recorded here. The first is a fix. The second is a
negative result.

## 1. The shipped signal was affecting scheduling, and should not have been

`docs/architecture/coordination.md` said intent evidence "remains advisory even
at a high score". It did not. `ConflictDetector.assess` summed every piece of
evidence — advisory included — into the one score the dispositions thresholds
are read against, and the guard that stopped intent evidence from blocking
applied only to pairs with *no* structural evidence at all:

```ts
const structural = items.some((entry) => entry.advisory !== true);
if (!structural && ["sequence", "block"].includes(disposition)) { ... }
```

So on a pair with any structural evidence, the advisory score — up to 30
points, against a `concurrent` ceiling of 20 and a `notify` ceiling of 45 —
could carry the total across a threshold on its own. One shared file (20,
concurrent) plus a firing intent signal (27) is 47: sequenced.

What that bought, measured on the team-queue runs: the shipped signal fired on
four pairs and was wrong on all four, catching none of the three real
collisions. It was costing parallelism on noise.

`assess` now computes a separate structural subtotal and reads the thresholds
against that. Advisory evidence is still scored, still recorded in the
evidence list, and can still lift a pair from `concurrent` to
`concurrent_with_notification` so a human looks — which costs nothing — but it
cannot reach `sequence` or `block`. The reported `score` still totals all
evidence, and the explanation now names the subtotal the disposition was
actually computed from, so the audit trail cannot mislead the same way again.

## 2. The replacement signal

Built as `@coord/intent-analysis`, three layers:

- **Lemmatization** (`wink-lemmatizer`). The shipped signal compared raw
  tokens, so "order"/"orders" and "charge"/"charging" were different words to
  it — the two most common ways two pricing tasks name the same thing. A
  lemmatizer rather than a stemmer, because the output is looked up in WordNet
  next and has to still be a word.
- **WordNet** (`wordnet-db`, read directly). Replaces a hardcoded list of ten
  opposing verb pairs with the real antonym relation, and adds synonym links
  so "charge"/"fee" corroborate each other. Read directly rather than through
  `natural`, which writes banner lines to stdout on import and this library
  loads inside a process whose stdout is a protocol stream.
- **Sentence embeddings** (`all-MiniLM-L6-v2`, 22.7M parameters, ~23MB
  quantized, via `@xenova/transformers` on onnxruntime). Gives a continuous
  cosine rather than a boolean.

The decision rule is a conjunction: a pair scores zero unless it has both a
lexical reason to think the two sentences name the same artefact *and* a
cosine above the floor. Requiring both is a deliberate bias towards precision,
since the failure being fixed was false positives.

## 3. The split, registered before the signal was written

`apps/worker/scripts/intent-holdout.mjs`.

The only corpus in this repository containing agent-written `intent` prose is
the three team-queue runs. Splitting them by run is not a split — all three
execute the same ten tasks, so the same objectives appear on both sides. The
split is therefore by **agent id**: development is `codex-a`/`codex-b`/`codex-c`,
held out is `codex-d`/`codex-e`, and a pair is held out if *either* task is.
The scenario assigns agents deliberately across bands, so this cuts across the
labels rather than along them. Labels are the scenario's own
`TEAM_QUEUE_TRUE_CONFLICTS`, pre-registered before any run happened.

`intent-signal-eval.mjs` refuses to evaluate both halves in one command, and
fails loudly if the scenario's agent assignment ever drifts from the one the
split was registered against.

## 4. Results

Parameters were chosen on the development half only and then frozen. On that
half the classes separate completely (every conflict ≥ 0.26 cosine, every
non-conflict ≤ 0.24), which excludes a region but does not locate a boundary,
so the operating point was set a priori towards the precision end of the
admissible range: effective cutoff 0.55 cosine.

**Development half** (40 pairs pooled over 3 runs, 15 positive):

| Signal | Fired | TP | FP | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| `intent_conflict` as shipped | 0 | 0 | 0 | n/a | 0% |
| corroborated + embedding | 7 | 7 | 0 | 100% | 47% |

**Held-out half, read once** (71 pairs pooled over 3 runs, 12 positive):

| Signal | Fired | TP | FP | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| `intent_conflict` as shipped | 5 | 3 | 2 | 60% | 25% |
| corroborated + embedding | **0** | 0 | 0 | **undefined** | **0%** |

Against the *observed* ground truth on the uncoordinated arm — which pairs
actually contended, rather than which were designed to — the shipped signal
fired 4 times on held-out pairs and was wrong 4 times: 0% precision. The new
signal fired 0 times.

Zero firings is not 100% precision. It is a signal with nothing to say, and it
does not clear the bar.

### Why it fails, and why tuning would not save it

The held-out cosines, as a post-hoc diagnostic — used to explain the result,
not to choose anything:

- Conflicting pairs: 0.25 – 0.49
- Non-conflicting pairs: −0.05 – 0.50

The single highest-scoring pair in the entire held-out set is a
**non-conflict**: `task_loyalty_tier` + `task_rounding` at 0.50. The six
partial-band pairs — the ones that are all about pricing but own different
modules — sit at 0.27–0.50, straight through the middle of the positive range.
Sweeping the threshold over the held-out data itself, which is cheating, the
best achievable is 75% precision at 75% recall. Even with hindsight it does not
reach 80%.

That is not a tuning failure, and a bigger model would not fix it. The label
asks whether at least one of the pair rewrites the shared caller `orderTotal`.
Two partial-band tasks are *maximally* similar in topic — both change what a
customer pays for an order — and are correctly labelled non-conflicting
because they own separate modules. Module ownership is not a property of the
sentence. Sentence similarity cannot express it, so no operating point on this
axis separates these classes.

The development half hid this because all of its negatives are pricing against
notifications or audit — the easy distinction. That is exactly what a held-out
split is for.

### Recall floor: the signal does understand the language

`intent-signal-recall-floor.mjs`, over the 40 real agent intents for
`task_checkout_fee` in `docs/benchmarks/data/grounding/*replan-substitution*`
— every pairing is the same work described twice, so there are no negatives
and this measures recall only:

| Same-work pairs | Corroborated | Fires | Median cosine |
| --- | --- | --- | --- |
| 780 | 100% | **96%** | 0.83 |

So the failure on team-queue is not a failure to recognise that two sentences
describe the same work. It is that "the same work" and "cannot both land
unexamined" are different questions, and only the first is answerable from
intent prose.

## 5. What is and is not wired in

- **Wired in:** the safety fix. Advisory evidence no longer contributes to the
  disposition. This is live in `ConflictDetector.assess` with a regression
  test.
- **Not wired in:** `@coord/intent-analysis`. No service imports it. The
  embedding dependency is optional and is not on any scheduling path. The
  package exists as the implementation and the measurement apparatus, ready if
  a corpus ever validates it.
- **Unchanged:** the shipped `analyzeIntent` still produces `intent_conflict`
  evidence from its ten hardcoded antonym pairs. It is now inert for
  scheduling and appears in the audit trail as an unvalidated advisory note.
  Replacing it would improve the quality of a notification that nothing acts
  on, and was left alone rather than done on the way past.

## 6. What would actually be needed

A signal that clears the bar on this label has to distinguish "changes the
total" from "changes an input to the total", which is a claim about the
repository and not about the sentence. The structural evidence classes already
have that information. The honest reading of this result is that intent prose
is the wrong input for the question, not that the model was too small — and
that a signal worth scheduling on would combine the grounded symbol graph with
intent, rather than reading intent alone.

That was tried: `docs/benchmarks/intent-grounding.md`. Grounding intent against
the repository index does work — of the recorded intents whose declared file
does not exist, 93% reach the file the agent meant but never named — but the
signal built on it scores 70%
precision at 58% recall on the same held-out half, and is also not wired in.
The part of the conclusion above that survives is narrower than it was written:
the problem is not finding the module, it is that "same file" and "linked by an
import" are the only relations a file-level index offers, and neither of them
is the relation the label turns on.

## Reproducing

```powershell
npm install --no-save @xenova/transformers
npx turbo run build
node apps/worker/scripts/intent-signal-eval.mjs --split=development docs/benchmarks/data/team-queue/*.json
node apps/worker/scripts/intent-signal-eval.mjs --split=held-out    docs/benchmarks/data/team-queue/*.json
node apps/worker/scripts/intent-signal-recall-floor.mjs
```

`@xenova/transformers` is deliberately not a declared dependency. It brings
onnxruntime, sharp and protobufjs with it — about 260MB — and given the
verdict above, nothing in the repository imports the code that would use it.
The install line above is the whole cost of reproducing these numbers.
Without it, everything still builds and the lexical half still runs; the
scripts report `embeddings unavailable` and the continuous score is not
computed.

The first run downloads the model (~23MB) to `.model-cache/`. The older
`intent-signal-report.mjs` scores the shipped signal and its lexical variants
on the same corpus without the split.
