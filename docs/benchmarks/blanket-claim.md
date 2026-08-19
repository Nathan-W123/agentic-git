# Blanket claims: how often is a task alone?

A task alone in its repository used to pay an agent planning round trip before
it could edit anything. That plan exists so a second task can arbitrate
against it. Where there is no second task, it buys nothing.

Whether removing it is mostly upside depends on one number: how often a second
task is admitted in a repository while another is already executing. Measured
first, before anything was built.

## The measurement

```
node scripts/measure-repository-contention.mjs --database <coordination.db>
```

Read from durable state only — every execution is a work lease, and its
issue/finish times are the interval. A lease that lapsed rather than settled is
counted to its expiry, the generous end, so contention is never undercounted.

Against this deployment's control-plane database on 2026-08-19, covering
2026-08-15 to 2026-08-19 (one repository, `LATTICE`):

| | |
|---|---|
| executions (work leases) | 259 |
| alone start to finish | 138 (53.3%) |
| overlapped another execution at some point | 121 (46.7%) |
| busy wall-clock with two or more executing | 29.9% |
| median execution | 4.6 minutes |
| alone at the moment they started | 172 (66.4%) |
| admissions recorded | 397 (69 named a blocker) |

**Read this honestly.** Slightly over half of executions never meet anybody and
keep their blanket claim to the end: those save a planning call outright. The
other 46.7% meet somebody at some point and are narrowed — but a freeze is a
synchronous `git diff`/`ls-files` pair against the holder's worktree, tens of
milliseconds, not an agent round trip. The planning call the *arriving* task
makes was always going to be paid.

So the saving is one planning call for each of the 172 executions (66.4%) that
were alone at the moment they started — those are the ones that get a blanket
claim at all — and the cost is one worktree read for whichever of them is later
joined. The 87 that started while somebody else was already running plan
exactly as they do today.

## What is saved

A planning round trip on this deployment is a full agent invocation against a
read-only checkout of the repository: `docs/benchmarks/plan-grounding.md`
records the surrounding arbitration at ~10.3s median against 232ms for the solo
fast path, and the planning call itself is minutes for a real model, not
seconds. A solo task also no longer builds a planning workspace at all — the
adapter destroys it the moment the claim is accepted.

The measured wall-clock difference for a solo task is therefore the whole
planning phase: everything between `task_started` and the first edit. The audit
log makes this directly checkable after the change — a blanket-claimed task has
a `blanket_claim_granted` event and no `plan_received` event at all.

## How the claim is represented

A blanket claim is an ordinary `AgentPlan` carrying `claim: {kind: "blanket"}`
and declaring nothing. That is what keeps every downstream path working
unchanged: scope enforcement, ownership, conflict assessment, the lease record
and partial admission are all handed a plan, and only two places read the
marker — scope validation (a claim approves what it covers) and the admission
controller (a claim held by an executing task blocks what it covers).

A frozen claim is the same plan with `claim: {kind: "frozen", directories}` and
`expectedFiles` set to what the holder had actually touched. From that moment
the task is an ordinary claimed task: reaching for a new file goes through the
existing widening path, which grants if free and refuses immediately if taken.

**Directories, not files.** A task frozen mid-sweep has touched three files of
a directory it is still working through; freezing it to exactly those files
would refuse it the fourth a second later, repeatedly, for the rest of a wide
refactor. The cost is that the arriving task is admitted to a little less than
it could strictly have had — it is refused a directory rather than a file.

## The window that remains

The freeze reads the worktree and writes the narrowed claim under the lease
store's compare-and-swap; nothing is granted away against a stale view, because
the arriving task cannot be admitted until it has read the narrowed record. The
one unavoidable gap is between the read and the write: a file created in that
millisecond is not in the frozen claim.

Two things cover it. Directory granularity means such a file is still covered
whenever it lives beside work already observed. And at collection, anything the
holder wrote outside its frozen claim is put through the ordinary widening
path — granted if nobody took it, and if somebody did, the task ends with an
explicit report naming the file and the holder rather than silently landing
over somebody else's work.

## Turning it off

`COORD_BLANKET_CLAIM=0` puts every task back through planning.
