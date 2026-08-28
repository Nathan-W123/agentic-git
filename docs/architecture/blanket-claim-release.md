# Releasing a blanket claim's untouched files

## The problem, in numbers

A task that arrives alone in a repository is handed a blanket claim: the
whole repository, granted without a planning round trip. This is cheap and
correct when the task really is alone, and it removes the single largest
fixed delay before a first edit.

The claim is not held to the end of the run. The *arrival* narrows it —
`narrowBlanketHolder` in `apps/cli/src/lease-admission.ts` reads the holder's
worktree and freezes the claim to the union of

- the lexical scope estimate the claim was granted against, and
- the paths the holder is demonstrably editing.

The union is deliberate and monotone: freezing to the estimate alone would
free a file the holder had open but never estimated, which is a double-claim.

What the union costs is the estimate's slack. Measured against nine
human-written commits on this branch, comparing `estimateScope` at each
commit's parent revision to what the commit actually changed:

```
130 files locked across 9 claims, 13 of them ever touched
precision  10%   nine of every ten locked files are never opened
recall     42%   the estimator misses most of what the work touches
```

Two individually: *"Pin the Docker base images"* locked 27 files and touched
two, neither of them estimated. *"Point two channel tests at what the code
does now"* locked 19 to touch one.

A holder therefore parks ~15–20 files and uses ~2. Everything else queues
behind it for up to `maxWaitMs` (30 minutes) before force-admit.

The commit subject is a proxy for a task objective — written after the work
rather than before — so these are directional, not exact.

## What exists already

A holder can hand files back: `scope_release_requested` → `handleScopeRelease`
→ `releaseFromBlanketClaim`. It verifies each named file is clean in the
holder's worktree before releasing it, and it narrows plan and leases in one
step.

It is **agent-initiated**. Nothing reclaims an untouched file on its own, so
the 10% precision above stands for the whole run unless the agent volunteers.

## The change

Release on contest, not on arrival and not preemptively.

When an arrival wants a file that a frozen blanket holder covers only through
its *estimate* — the holder has never written to it — hand it to the arrival
at that moment, after proving it clean in the holder's worktree.

Concretely, in `narrowBlanketHolder`:

- it already has `observed`, the holder's dirty paths, from `observeHolder`
- it already knows the arrival's requested files from `request.plan`
- so: drop from the freeze any estimated path that is (a) wanted by the
  arrival and (b) absent from `observed`

Everything else is unchanged. A file nobody is asking for stays with the
holder; a file the holder has touched stays with the holder whether or not
somebody wants it.

## Why this is safe where preemptive release is not

`handleScopeRelease` documents why the coordinator does not infer releases:

> conflict repair sends the agent back into files it had already finished
> with — `repairChangeSet` re-collects and re-validates against this same
> plan — so a file dropped at collection could be handed back to the agent
> seconds later with neither the lease nor the plan entry it needs

That objection is about releasing a file the agent has *worked in* and
appears finished with. This releases only files the agent has never written
to, verified at the moment of release, so there is no patch for repair to
re-collect and no hunk to re-validate.

The cleanliness check is the same one `handleScopeRelease` already performs;
this reuses it rather than inventing a second notion of "finished with".

## What it costs

A blanket holder that later reaches into a released file is refused when it
tries to widen, **and that task fails**. `claimOccupiesPath` says so plainly:

> A holder that later reaches into a file granted away is refused when it
> tries to widen, and that task fails. Reaching for what you never named is
> the rarer accident; being locked out of a directory somebody else brushed
> against was the common one.

That is not a new risk this introduces. It is the trade the frozen claim
already makes for *directories* — a freeze carries the directories its files
live in, and arbitration deliberately does not read them as a hold, so one
task touching one file does not queue everybody behind the other seventeen.
This extends the same rule from directories to estimated-but-untouched
files, with the same accepted cost and the same reasoning.

Two things bound it. The release is contest-driven, so a holder alone in the
repository loses nothing. And the released file is one the holder has never
written to, so nothing it has already done is thrown away.

### Why the refused holder cannot simply wait

The obvious softening — let the refused holder wait for the other task and
then proceed — is the one thing that can deadlock, and the widening path
rules it out on purpose:

> decided against every other holder, granted or refused immediately, never
> queued. Nothing here waits on a lease while holding one.

Hold-and-wait is the whole condition: A holds `x` and wants `y`, B holds `y`
and wants `x`, and both wait forever. Refusing immediately is what makes the
cycle impossible.

The safe shape of "wait, then go" is to let go first — requeue the task and
re-admit it later against a clear board, which is what already happens for
genuine contention at integration time. That trades a hard failure for
re-running the agent, and is worth doing as a follow-up rather than as part
of this change: it is a change to what a refused widening *does*, which is
orthogonal to which files are held in the first place, and it should be
measured on its own.

## How to tell whether it worked

The precision figure above is the number to beat, and it is reproducible:
estimate at the parent revision, intersect with the commit's real footprint.

Beyond it, the existing team-queue metrics already carry the signal —
`deferredIterations` against `acceptedIterations`, and wall-clock to drain a
queue. Note that the `team-queue` scenario is a synthetic six-file corpus
built to force contention, so it will not show this: the estimate has no
slack to give back there. A benchmark against a repository of this size is
what would.

## Not in scope

Sharing a file two tasks are both inside. That is a separate mechanism
(`admitWithinFiles`), it already works for planned holders, and it is
deliberately withdrawn for blanket holders — a task that never planned has
told nobody where it is going, so its written lines are a lower bound on its
footprint and nothing more.
