# Blanket claim over the worker protocol

A design for giving a solo agent back its repository claim after execution moved
onto people's own machines.

## What is actually missing

Less than it looks, and not what it looked like from outside.

A blanket claim is granted at `coordinator.ts:2179`, inside the **in-process**
coordinator's run loop, under conditions it states plainly: one task in the wave,
a first turn rather than a replan, an adapter that can be told its scope, a
workspace manager that can report working changes, and an anchored scope estimate
to narrow against. A desktop worker reaches none of it. Its whole vocabulary is

    register · lease · heartbeat · bundle · submitPlan
    requestScopeChange · report · release · progress

so it leases, fetches a bundle, and goes straight to `submitPlan`.
`claimRepository` is never called and the adapter's `acceptBlanketClaim` is never
reached. Nothing broke; Phase 2 moved execution to the far side of a boundary the
claim step does not cross.

Two things went with it:

- **The claim.** A solo agent no longer skips the planning round trip by taking
  the repository and narrowing later.
- **The narrowing.** `freezeBlanketClaim` converts a held claim the moment a
  second agent arrives. Same file, same unreachable side.

## The part that is already built

`freezeBlanketClaim` does **not** reach into the holder to narrow it. It edits the
lease row, under the same compare-and-swap every admission uses, and its own
comment says why that is the design:

> Not a task this run is executing, which is the arrival's case: the holder
> belongs to another run, and the lease table is the only thing the two of them
> can both see.

So the arrival already narrows a holder it cannot address, in a process that is
not the holder's, through durable state. A *remote* holder is the same problem
this already solves. There is no push channel to build and no new consistency
story to invent — the compare-and-swap, the `replaceApproved` path, and the rule
that a claim is never re-widened past what it currently names all apply
unchanged.

What is missing is narrower than "narrowing": the holder has to **learn** it was
narrowed, and the freeze needs two facts that today come from local callbacks.

## The two facts that have to travel

`freezeBlanketClaim` takes them as callbacks, because in-process they are a
function call away:

- **`observe()`** — the paths this holder has already written. Used to freeze the
  claim onto ground the holder is standing on. Cheap: a list of repository paths.
- **`declare()`** — the holder is *paused, asked what the rest of its work needs,
  and resumed*, and what it says becomes an ordinary plan. This is a live question
  to a running agent, and it is the difference between the arrival running and the
  arrival waiting.

`observe` is data the worker already has. `declare` is a round trip to a machine
that may be on a laptop on a train.

## The asynchrony is already designed for

This is the part that makes the whole thing tractable, and it was written before
any of it was remote. `freezeBlanketClaim` already handles an answer that has not
come back yet, and refuses to fall back to a plain freeze when it happens:

> The holder is still answering. Freezing here is not "fall back to today's
> behaviour" — it is worse than it, because the freeze is permanent … One answer
> that arrived a second late therefore locked the whole repository for the rest of
> the run.
>
> Leaving the claim blanket is the recoverable state. The arrival takes the retry
> it would have taken anyway, the ask is still in flight in the holder registry,
> and the next arrival joins the same promise and finds it settled.

`BlanketAskPending` is exactly the shape a network round trip needs. An ask that
is in flight to a desktop is an ask that has not answered yet, and the arrival's
behaviour is already specified: retry, join, do not freeze early.

## The design

**The heartbeat is the channel.** It already runs every 60 seconds against a live
lease, already carries the worker's token usage up, and already carries
lease-loss down. Both directions of this feature fit on it, and nothing new has to
stay connected.

### Up, on every heartbeat while a claim is held

    workingChanges?: string[]      // what `observe()` answers

Bounded and cheap. Only sent while the lease's plan is a blanket claim, so an
ordinary run pays nothing.

### Down, in the heartbeat response

    narrowedPlan?: AgentPlan       // your claim became this — adopt it
    declareScope?: { askId: string }   // say what the rest of your work needs

`narrowedPlan` is what the holder was previously told by a local poll, and the
comment on that path already explains why answering matters: *"a coordinator whose
tick gets nothing back goes on believing it holds the repository, and goes on
telling its agent so."* A remote holder that is not told is that same bug at a
distance.

### A new worker call, for the answer only

    POST /workers/leases/:id/declaration   { askId, declaration }

The worker asks its adapter, and posts the answer when it has one. Between the
request and the post, arrivals get `BlanketAskPending` and retry, which is what
they already do.

### The claim itself

    POST /workers/leases/:id/claim   → AgentPlan | 204

Called by the worker after `bundle` and before `submitPlan`. The gateway runs the
existing `claimRepository`, including the scope estimate — which needs a symbol
index at that revision, and is deliberately the expensive step:

> Paid for with an index build the solo path otherwise skips … indexing is the
> most expensive step in the control plane, but a planning round trip is an agent
> round trip, and this is the cheaper of the two.

That trade was made for a local agent whose round trip was in-process. For a
desktop worker the planning round trip is *more* expensive, not less, so the trade
gets better, not worse. A 204 means the conditions were not met and the worker
plans exactly as it does today.

### Version

`WORKER_PROTOCOL_VERSION` goes 2 → 3. The gateway keeps answering 2 for a worker
that has not been updated: it never sends `declareScope`, never narrows a plan it
cannot tell the holder about, and therefore never grants a claim to a version-2
worker in the first place. An old desktop app behaves exactly as it does now.

## Phases

**Phase 1 — the claim, alone.** `POST …/claim`, the worker calling it, the adapter
accepting it. No narrowing. Ship it behind the existing `COORD_BLANKET_CLAIM=0`
escape hatch and with the grant condition tightened to *"only when this repository
has one live worker"*, so an ungrantable claim cannot strand anybody while the
rest is built. Verifiable on its own: a solo task should skip its planning round
trip and start editing sooner.

**Phase 2 — `observe`.** `workingChanges` on the heartbeat, and `narrowedPlan` in
the response. The arrival can now freeze a remote holder onto its observed writes,
which is the whole safety property; the holder learns within one heartbeat.

**Phase 3 — `declare`.** The ask, the `BlanketAskPending` path across the wire, and
the declaration route. This is the one that turns "the arrival waits a minute" into
"the arrival runs now", and it is the only phase with a genuinely new failure mode
— an ask to a machine that has gone away. The existing answer applies: the claim
stays blanket, which is recoverable, and the force-admit bound in `admit` is what
stops anybody waiting forever.

**Phase 4 — remove the tightened condition** from Phase 1, once narrowing works.

## Risks

- **A claim that cannot be narrowed is worse than no claim.** With two people
  mostly in one repository, a solo claim held by an unreachable laptop blocks the
  other person until the task ends. This is the same trade the existing
  `listWorkingChanges` guard already refuses to make, and it is why Phase 1 ships
  with a one-worker condition rather than on its own merits.
- **One heartbeat of latency on adoption.** The holder can be editing under a
  claim that has already been narrowed off the lease table. The arrival is safe —
  it was granted only what the freeze took away — but the holder may write a file
  it no longer holds and find out at integration. The existing exact-base
  integration check is what catches it; whether that is acceptable or whether the
  heartbeat needs shortening while a claim is held is the open question of Phase 2.
- **The index cost moves onto the request path.** In-process it was a step inside a
  run. Here it is inside a worker's HTTP call, with a laptop waiting on it. It
  needs a deadline, and a claim that cannot be estimated in time has to answer 204
  rather than hold the worker up — the fall-through is free, the wait is not.
- **`declare` pauses a running agent.** In-process that is a local pause. Across the
  wire it is a pause plus two network hops, on somebody's own machine, spending
  their own quota to answer a question about somebody else's task.

## What this does not change

Arbitration, admission, and integration are untouched. Every write still goes
through `saveWorkLeasePlan`'s compare-and-swap, a claim is still never re-widened,
and a worker that does not speak version 3 still plans the way it does today.
