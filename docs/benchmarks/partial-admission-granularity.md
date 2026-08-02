# How much a partial admission gives up

Partial admission grants a plan the part of its scope nobody else is holding
and withholds the rest. The question this page answers is how *coarse* that
withholding is — how much work a task loses that nobody was actually contesting
— and what the remaining coarseness costs.

## The two granularities

There are two separate withholding decisions, and they have different limits.

**A contested file is withheld whole — unless its holder occupies known
lines.** The plan declared `src/pricing/total.js` and an executing task holds
it. If that task named the file too, the file is dropped from the reduced plan,
the holder gets no lease on it, and a patch on that path is refused on its path
alone. If instead the holder reaches into the file only through code the index
could place, [only those lines are
withheld](#granting-the-rest-of-a-contested-file) and the rest of the file is
granted.

**A contested symbol inside a *granted* file is withheld by line range.** The
plan declared `src/a.ts` and nobody else wants that file, but a symbol inside
it — reached through the plan's enriched claims, or through a grounded referent
— is owned by another task. The file is granted; the symbol's lines are not.
This is the case that used to cost the whole file anyway, and no longer does.

## What changed

Enforcement used to work like this: `namesTouchedByPatch` walked the patch
body, and if any changed line fell inside a withheld symbol's range, the
**entire file patch** was held back. Every other edit the agent made to that
file went with it, into a follow-up task that pays for a whole second agent
run.

`dividePatchByRanges` replaces that with a hunk-level split. Each hunk is
judged by the base-revision lines it actually changes; the hunks clear of every
withheld range are re-emitted as a patch in their own right and promoted, and
only the trespassing hunks are held back.

The old side of each hunk needs no adjustment — it is measured against the base
revision, which does not move when a sibling hunk is dropped. The new side
does, and is recomputed from the running line delta of the hunks that survived,
including git's two off-by-one conventions for pure insertions and pure
deletions.

### Refusals

Division returns "not divisible" — and the caller falls back to losing the file
whole — for a binary patch, a patch spanning more than one file, a patch
carrying `\ No newline at end of file` (whose meaning depends on the hunk being
the file's last), a hunk header whose counts disagree with its body (the
signature of a misparse), and any patch on a file being added or deleted, where
"part of the change" is not a thing that exists.

### The risk it does not remove

Hunks are not independent. A rename in one hunk and its call sites in another
are one change, and promoting half of that produces code that does not build.
Division does not detect this and does not try to. It is caught where every
other broken changeset is caught: the granted half goes through transactional
integration with the task's own validation commands, and a failure leaves
canonical untouched and requeues the task. Division trades a guaranteed loss of
uncontested work for a chance of a validation failure that the system already
had to handle.

## Verification

`scripts/verify-patch-division.mjs` builds real Git repositories, produces real
`git diff --binary --full-index` output, divides it, and checks with real
`git apply --3way` that:

1. the granted half applies to the base revision,
2. it leaves every withheld line exactly as the base had it,
3. the deferred half applies on top of it,
4. the result is byte-identical to applying the undivided patch.

Five scenarios pass, including the ones where renumbering is load-bearing: a
granted hunk that deletes lines before a deferred one, a granted hunk that
inserts lines before a deferred one, a withheld window before the granted edit,
and a three-hunk patch with the middle hunk withheld.

## Measurement

`scripts/measure-hunk-withholding.mjs` measures the recovered work on real
diffs rather than constructed ones. It takes a window of this repository's own
history, diffs every source file it changed against one common base — the shape
the coordinator sees, where every patch in a changeset is written against the
revision the agent started from — indexes that base with the real
`CodeIntelligenceService`, and then, for every symbol each patch actually
touches, asks what withholding that one symbol would cost.

One symbol contested inside a file the plan otherwise owns is exactly what
`contestedSymbols` produces, so the corpus is the shape the code meets.

All four windows below end at `8b920d79`; re-running against a later `HEAD`
measures a different corpus, so the base is recorded to keep the figures
checkable.

| Window | Base | Trespassing cases | Divided | Changed lines promoted | Hunks promoted |
| --- | --- | --- | --- | --- | --- |
| 2 commits | `5e0194ba` | 127 | 121 | 3,395 / 6,230 (**54%**) | 845 / 1,311 (64%) |
| 5 commits | `9e252efd` | 165 | 158 | 9,603 / 15,052 (**64%**) | 2,145 / 3,007 (71%) |
| 15 commits | `963b0b05` | 223 | 208 | 26,674 / 35,864 (**74%**) | 4,013 / 5,122 (78%) |
| 40 commits | `9b317344` | 438 | 421 | 86,701 / 115,779 (**75%**) | 11,110 / 12,996 (85%) |

Before this change every one of those figures was **0%**: a trespassing hunk
cost the whole file. No case in any window was indivisible; the cases that
recovered nothing (6 to 17 per window) were patches where every hunk genuinely
reached the withheld symbol, which is the correct answer rather than a failure.

The recovery rate rises with window size because a wider diff means more hunks
per file and therefore more that can be separated from the contested one. The
narrow windows are the ones to plan around: **a realistically-sized changeset
recovers a bit over half of what it used to lose.**

This is a measurement of the enforcement path in isolation. It says how much of
a contested file survives; it does not say how often partial admission fires,
which depends on the repository parallelism setting and on how much real
contention a team generates.

## Granting the rest of a contested file

Withholding only the *lines* of a contested file that its holder occupies, and
granting the rest, needed two changes, in this order. Both are now made.

**A file lease can be narrower than the file.** `ResourceLease` carries an
optional set of line ranges, and two exclusive claims on one path collide only
when those ranges meet. A claim that names no ranges still means the whole
file, so a lease that could not say anything finer refuses exactly what it
refused before. The narrowing happens *at issue time*, for every plan the
admission can see rather than only for the candidate — the earlier obstacle
was that a holder's lease could not be narrowed retroactively, and it does not
have to be if it was never wide.

**`file_overlap` is scored on intersecting ranges, not on shared paths.**
`ConflictDetector.assess` takes an optional view of what each plan occupies
inside a file. A path both plans name but neither meets the other inside stops
being evidence. Without that view — every caller that does not supply one —
scoring is byte-for-byte what it was.

With both in place the candidate's own claim can be narrowed too: its claim on
the contested file becomes the whole file *minus* the holder's ranges, which is
a claim the holder's lease does not intersect and the detector does not score.
That is what turns "wait for total.js" into "take total.js except lines 40–80".

### Which holders are narrow, and which are not

The rule is deliberately reluctant, because a claim narrower than the truth
hands another task lines this one will edit:

- **A file the plan named is the plan's, all of it.** An agent told to edit a
  file edits it wherever it needs to, including the lines between the symbols
  an index can name and lines that did not exist when the index was built.
  This is also why deriving a narrower claim from the plan's *symbols* would be
  illusory: enrichment already makes a plan that names a file claim that file's
  symbols, so the derived ranges would cover it anyway.
- **A file a misnamed path grounds to is the same case.** The plan meant to
  edit that whole file; it just called it something else.
- **A file the plan reaches only because verification mapped a symbol onto code
  living there** is the narrow case. The plan never said `total.js` — it said
  `calculateTotal` — and the index knows exactly which lines that is.

So the holder that can be narrowed is the one that reached the file through a
grounded referent, which is precisely the shape the substitution benchmarks
produce. If any symbol reaching in cannot be placed, or the file cannot be
parsed, the whole file is the answer again and the file is withheld as before.

The candidate side has one more requirement: it must have *declared* the path.
What a division holds back are hunks of a patch on that path, and a path the
plan only reached through a misname is not one any patch will carry.

### How it is enforced

The withholding is expressed as the holder's **symbols**, with their locations
in the granted file — not as a partial file resource. That is not
presentational. A withheld symbol carrying `locations` is exactly the shape
`splitChangeSet` already divides a granted file's patch by, so a sub-file grant
is enforced by the machinery above, which was already tested against real
`git apply`, and the ranges are re-derived from the base index by name rather
than trusted from a decision that travelled over the wire.

### How often the narrow case exists

The rule only bites on a holder that reached a file through a grounded symbol
referent, so it is worth knowing whether real agents produce that shape at all
rather than assuming it. Counted over the *tracked* records in
`docs/benchmarks/data/grounding` — every plan-grounding record in each file,
asking whether any `symbolReferents` entry names a file the plan neither
declared nor reached through a `fileReferents` mapping. Only committed data is
counted, so the figures are reproducible at this revision:

| Corpus | Grounding records | Reaching an undeclared file |
| --- | --- | --- |
| `live-checkout-trio-replan-substitution-*` | 40 | **30 (75%)** |
| `live-checkout-after-*` | 10 | 1 |
| everything else | 44 | 0 |
| all tracked | 94 | **31 (33%)** |

The substitution runs are where it lives, and they are the same shape every
time: a plan declaring `src/checkout.js`, which does not exist, whose symbol
claims verification placed in `src/pricing/total.js`, which it never named.
That is not a coincidence — those runs exist to produce misnaming, and
misnaming is exactly what makes a plan's reach into a file narrower than the
file.

This counts the *holder* shape and nothing more. Whether one becomes a partial
grant also needs a candidate that declared the same path, an index that places
every symbol reaching in, and the two to be executing at once — none of which
this measures.

### What this did *not* change

The recorded numbers in [README.md](README.md) and
[live-evidence.md](live-evidence.md) stand. Every pair where at least one side
declared the shared path scores and leases exactly as it did: the ranged path
is reachable only when both sides' claims are bounded, and a plan that named a
file is never bounded. No lease exists now that did not exist before except a
ranged one on a file a plan reached only through grounding, and a ranged lease
cannot refuse anything a whole-file lease would have let through.

What does behave differently is a contest where the *holder* reached the file
through a grounded referent — which is a case those runs contain. Those pairs
now run concurrently, or partially, where they were sequenced. That is a change
worth its own before/after measurement; it has not been measured here, and no
figure above has been restated to claim otherwise.

### Verification

`scripts/verify-contested-file-division.mjs` carries one contest end to end
against real machinery: it builds a repository, indexes it with the real
`CodeIntelligenceService` so the withheld ranges are a parser's answer, runs a
real `PlanAdmissionController` on a candidate declaring the contested file
against a holder occupying one function in it, has an agent edit *both*
functions, produces a real `git diff --binary --full-index`, splits it on the
admission's own ranges, and applies the granted half with the flags
`IntegrationService` uses. It then checks the thing the whole feature rests on:
every line of the holder's function is byte-identical to base, the holder's
edit did not sneak through, the candidate's own work did land, and the deferred
half still applies on top to reproduce the undivided change.

The honest statement of the granularity is now: **a contested file is
all-or-nothing only when its holder claimed all of it; a contested symbol, and
a holder that occupies known lines, cost hunks rather than files.**
