# How much a partial admission gives up

Partial admission grants a plan the part of its scope nobody else is holding
and withholds the rest. The question this page answers is how *coarse* that
withholding is — how much work a task loses that nobody was actually contesting
— and what the remaining coarseness costs.

## The two granularities

There are two separate withholding decisions, and they have different limits.

**A contested file is withheld whole.** The plan declared `src/pricing/total.js`
and an executing task holds it. The file is dropped from the reduced plan, the
holder gets no lease on it, and a patch on that path is refused on its path
alone. This is coarse by construction and [cannot currently be made
finer](#what-is-still-withheld-whole-and-why).

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

## What is still withheld whole, and why

The obvious next step — withholding only the *lines* of a contested file that
the other holder actually occupies, and granting the rest of that file — is not
implemented, and cannot be made sound without two changes this one does not
make. It is worth stating precisely, because the plan schema is not the
obstacle people expect it to be.

**It is not blocked by the plan schema.** The granularity needed does not come
from the candidate's plan at all. It comes from the *holder's* declared symbols
resolved to line ranges through the base-revision index — exactly the machinery
`contestedSymbols` already uses. An agent would not have to declare hunks or
line ranges for this to work, and no `AgentPlan` field is missing.

**It is blocked by what a file lease means.** `DefaultOwnershipPolicy` leases a
source file `exclusive`. When the contest is discovered, the holder already has
that lease and its agent has already been told it owns the file. Granting a
second task write access to other lines of the same file would be handing out
access behind a live exclusive lease — the invariant the whole ownership model
rests on. Narrowing the holder's lease retroactively is not available either:
it was issued before this candidate existed.

**It is also blocked one layer earlier, in conflict scoring.** Even if leases
were narrowed, `decide()` consults the `ConflictDetector` *before* ownership,
and `file_overlap` evidence sequences two plans that name the same file
regardless of what they do inside it. A plan reduced to "lines 40–80 of
total.js" would still be refused by the detector on the path alone.

So the two changes required, in order, are:

1. `DefaultOwnershipPolicy` issues line-range leases instead of whole-file
   leases wherever the index can locate a plan's symbols, falling back to the
   file when it cannot — applied to *every* plan at admission, not just to the
   candidate, so both sides of a contest are narrow.
2. `ConflictDetector` scores `file_overlap` on intersecting line ranges rather
   than on shared paths.

Both are load-bearing changes to the numbers in
[README.md](README.md) and [live-evidence.md](live-evidence.md), because
`file_overlap` is what produces the sequencing those results measure. They are
not a follow-up to this change; they are a separate experiment with its own
before/after, and doing them as a side effect of hunk-level enforcement would
have invalidated the recorded evidence without measuring what replaced it.

Until then, the honest statement of the granularity is: **a contested file is
all-or-nothing; a contested symbol inside a granted file costs hunks, not
files.**
