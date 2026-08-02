# The sighted re-run of the name-substitution experiment did not test it

Twenty-seven paired samples were collected on 31 July 2026 under the label
`replan-substitution-sighted`, re-running the experiment in
[`plan-grounding.md`](plan-grounding.md) with a Codex install that could read
the repository during planning. Read naively, they look like a refutation: the
control hallucinated in 17 of 27 and the treatment in 18 of 27, and adoption
fell from near-ceiling to 2 of 27.

That reading is wrong, and the data says so itself. **In 25 of the 27 samples
the treatment prompt was identical to the control prompt.** The re-run did not
measure a weaker effect; it measured nothing, because a sighted agent does not
make the mistake substitution exists to correct.

This page records that finding so the raw records in
`data/grounding/*replan-substitution-sighted-*` are not mistaken for a null
result.

## Why the arms were identical

The two arms differ only by `COORD_UNGROUNDED_REPLAN`, which
`replan-substitution-experiment.mjs` sets to `1` for the control and unsets for
the treatment. The variable is read in
[`adapters/codex/src/index.ts:1020`](../../adapters/codex/src/index.ts), inside
`groundedPreviousPlan`. Three lines later:

```js
const view = substituteGroundedNames(request.previousPlan);
if (view.substitutions.length === 0 && view.inventedFiles.length === 0) {
  return [`Previous plan: ${JSON.stringify(view.plan)}`];
}
```

When grounding resolved nothing, the treatment returns the same
`Previous plan: …` line the control returns. Substitution acts only on a
declaration the coordinator could map to a real name; with no such declaration
there is nothing to substitute, and the two prompts converge.

This is not a discovered flaw. `plan-grounding.md` states the same constraint
as a pre-registered inclusion rule — "a first plan with nothing to correct
produces an identical prompt in both arms and cannot possibly discriminate
between them" — and `summarize-replan-substitution.mjs` enforces it by scoring
only samples with at least one resolved referent.

## The precondition collapsed

| | blind (first 20) | blind `b2` (20) | **sighted (27)** |
| --- | --- | --- | --- |
| First plan named something that does not exist | 15/20 | 19/20 | 19/27 |
| **First plan had a resolvable referent** (scorable) | **13/20** | **17/20** | **2/27** |
| Control and treatment records byte-identical | 7/20 | 7/20 | **24/27** |

The middle row is the experiment's precondition, and it fell from 85% to 7%.

The cause is visible in what the first plans declared. The fixture's real files
are `src/pricing/total.js` and `test/pricing.test.js`; there is no
`src/checkout.js` and no `test/checkout.test.js`.

- **Blind runs.** The task objective is phrased in checkout vocabulary, and an
  agent that cannot open the repository guesses from it: `src/checkout.js`
  (12/20), `test/checkout.test.js` (13/20), `calculateTotal` (14/20). Grounding
  mapped `calculateTotal → orderTotal` in 14 of 20 samples. That is exactly the
  material substitution operates on.
- **Sighted runs.** All 27 first plans named `src/pricing/total.js` and
  `test/pricing.test.js` — the real files, correctly, on the first attempt. The
  names left over are `HANDLING_CHARGE` and `HANDLING_FEE`, constants the plan
  intends to *create*, and prose test descriptions such as `order total applies
  tax and handling charge`. Neither kind is a misnaming of existing code, so
  grounding correctly declines to substitute them, and only 2 samples produced a
  referent at all.

Median wall-clock rose from 143 s to 219 s, consistent with an agent that is
actually reading files rather than guessing from the objective.

## Where the headline numbers come from

The 17-vs-18 and 2-of-27 figures come from scoring all 27 samples, including
the 25 in which both arms received the same prompt. Two artifacts follow:

- **The hallucination rates are the same because the prompts were the same.**
  Control 17/27 versus treatment 18/27 is one sample of difference between two
  arms that were, in 25 cases, the same arm run twice. Three sample pairs
  diverged despite identical prompts, which is ordinary sampling
  nondeterminism and a useful reminder that identical input does not mean
  identical output.
- **The adoption collapse is a denominator artifact.** `adoptedAll` is computed
  as `resolved.size > 0 && adopted.length === resolved.size`. When grounding
  resolved nothing, `resolved.size` is 0 and `adoptedAll` is structurally
  `false`. The 25 unscorable samples cannot score adoption, so 17/20 → 2/27 is
  arithmetic, not behaviour.

Scored by the pre-registered rule, the sighted collection contributes **2 usable
pairs**, which supports no conclusion in either direction.

## Two defects worth fixing

Neither is in the manipulation logic, which is correct.

1. **The harness records unscorable samples indistinguishably from scorable
   ones.** `replan-substitution-experiment.mjs` writes every sample in the same
   shape with no field recording whether substitution had anything to act on.
   Recovering that requires knowing to inspect `firstPlan.grounding.*Referents`
   and knowing why it matters. A `substitutionApplied` boolean — ideally the
   prompt delta itself — would make a void sample self-evident in the raw
   record, and would have prevented this misreading. The console line printed
   per sample has the same gap.

2. **The summarizer pools incomparable collections.**
   `summarize-replan-substitution.mjs` selects files with
   `name.includes("replan-substitution")`, which matches the sighted label too.
   With these 27 files in `data/grounding/`, it now reports 67 samples and 32
   scored pairs; `plan-grounding.md` documents 40 and 30. The published table
   shifts accordingly (overall hallucination 25/30 → 26/32, repeats 19/30 →
   20/32). The blind and sighted conditions are not the same experiment and
   should not share a denominator — the summarizer needs a label filter.

## What can and cannot be concluded

**Cannot:** anything about whether name substitution helps a sighted agent. The
experiment did not run under that condition in any meaningful sense.

**Can:** the intervention's applicability is narrower than the blind experiment
suggests, and in a way that is favourable rather than disappointing. Substitution
corrects an agent that misnames real code. An agent that can read the repository
during planning largely does not misname it — 27 of 27 first plans got both
files right. The published effect is real for the condition it was measured in;
that condition is a planning agent working without repository access, which is
the degraded mode described under "What this measurement cannot say" in
`plan-grounding.md`.

Deciding whether substitution matters when the agent is sighted needs a task
whose correct targets a sighted agent still gets wrong — otherwise the
precondition will keep collapsing and the run will keep costing an hour to
produce two usable pairs.

## Reproducing

No agent calls are required; the analysis is entirely over committed JSON.

```bash
node apps/cli/scripts/summarize-replan-substitution.mjs docs/benchmarks/data/grounding
```

The per-family counts in the table above come from reading
`firstPlan.grounding.fileReferents` and `symbolReferents` for each sample and
comparing the serialised `arms.control` and `arms.treatment` objects.
