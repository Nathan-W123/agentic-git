# Incremental milestone landing

A design for letting a task release part of its scope before it finishes, so
the next agent can start on those files instead of waiting for the whole task.

Not built. Written after production showed the referee working — a second task
correctly held behind a seven-file first task — and the obvious next question
was whether the hold has to last that long.

## What this is actually for

Today a lease covers every file its plan declared, from admission until the
task settles (`leaseNextTask` through `finishWorkLease`, wired in
`runPendingTasks`). An agent that finishes `models.py` in its first minute and
then spends twenty on `reports.py` holds `models.py` for all twenty-one.

The naive fix — let the agent release a file when it stops editing it — makes
things **worse**, and it is worth being precise about why, because the
reasoning is what shapes everything below.

A lease does not mean "I am typing in this file." It means **"my edits to this
file are not in canonical yet."** Release `models.py` early and the next agent
starts from a canonical that still lacks the first agent's `models.py` work. It
plans against the old content, edits it, and collides at landing time anyway —
having now burned a full execution instead of waiting. That is precisely the
wasted-execution failure the plan-lease referee exists to prevent,
reintroduced through the back door.

**Early release is only sound if the work also becomes visible.** Releasing and
landing are the same event, or the feature is a bug.

## Why the file is the wrong unit

If landing is the price of releasing, then whatever is released has to be
landable: it has to integrate and pass the repository's validation commands on
its own. A file does not qualify. An agent that has finished `models.py` but
has not yet updated `storage.py` to match has a tree that does not build.
Landing `models.py` alone breaks canonical for everybody.

So the unit is a **milestone**: a set of files the agent asserts is complete
*and self-consistent*. Only the agent knows where those boundaries fall.

The critical property — and the thing that makes this safe to build — is that
the agent's assertion **does not have to be trusted**. A milestone is a
proposal. Integration already runs the repository's validation commands
(`IntegrationService.integrate`, called at `coordinator.ts:1810`, taking
`validationCommands`). If the milestone does not build, validation fails, the
milestone is refused, and nothing is lost — the agent simply keeps working and
lands everything at the end as it does today.

Validation is the adjudicator. The agent proposes a boundary; the existing gate
decides whether it really was one.

## The shape

Mid-execution re-arbitration already exists, for widening: an agent emits
`scope_change_requested`, the coordinator grounds a revised plan, checks it for
conflicts, acquires ownership, and answers with a `ScopeChangeDecision`
(`coordinator.ts:1490-1604`). Narrowing is the mirror image and should look
like it. Anyone who has read the scope-change path should recognise this one.

### 1. Protocol

A new agent event in `adapters/generic-cli/src/protocol.ts`, alongside
`scope_change_requested`:

```
{ event: "milestone_reached", files: string[], reason: string, occurredAt }
```

And a host reply, alongside `scope_decision`:

```
{ type: "milestone_decision", sessionId, decision: {
    requestId, taskId,
    decision: "landed" | "refused",
    landedFiles: string[],
    revisedPlan: AgentPlan,
    revision: string,          // the canonical revision it became
    explanation: string,
} }
```

`parseAgentEvent` gains a case; `MilestoneDecisionMessage` joins `HostMessage`.
An agent that never emits the event is unaffected, which is every agent today.

### 2. Coordinator

`handleMilestone`, called from the `handleAgentEvent` switch, mirroring
`handleScopeChange`:

1. **Refuse the obviously wrong.** Empty file list, no reason, or files outside
   the granted plan → refused without touching anything. A milestone naming a
   file the task was never granted is the scope-enforcement violation
   `assertChangeSetWithinPlan` already exists to catch, arriving early.
2. **Collect the change set** for the named files only. The workspace is
   already being read for working-change reporting (`watchWorkingChanges`), so
   the machinery is there.
3. **Split.** `splitChangeSet` (`services/coordinator/src/partial-admission.ts:73`)
   already divides a change set into granted and deferred halves against an
   admission, including symbol-level withholding. A milestone is the same
   operation with the milestone's files as the granted set.
4. **Integrate and validate** the milestone half through the ordinary
   `integrations.integrate` path, with its own commit message
   (`coord(<task>): <objective> [milestone <n>]`).
5. **On validation failure** — refuse. Trace it, tell the agent, change nothing.
   This is the expected outcome for a badly-chosen boundary and must be cheap.
6. **On success** — promote (`canonical_promoted`), then narrow: the plan
   (`reducePlanScope`, already imported), the in-memory ownership
   (`OwnershipService.release` for the landed resources), and the durable lease
   (below). Bump `planRevision` and record a `plan_revised` with reason
   `milestone`, exactly as the scope-change path does.

### 3. The lease, and the waiter

The durable half is one call:

```ts
store.saveWorkLeasePlan({
  leaseId,
  submission: { plan: narrowedPlan, admission: narrowedAdmission },
  observedApprovedLeaseIds,
  replaceApproved: true,
})
```

`replaceApproved` exists for exactly this class of caller — mid-execution
arbitration that legitimately rewrites an approved contract, having just
decided it through the same services. It is used today only by the widening
path (`worker-operations.ts:2073`).

**The waiter needs no new mechanism at all.** Tasks deferred by
`LeasePlanAuthority` are re-decided on a timer by the coordinator's wave loop.
The next retry reads the narrowed plan and admits them on the freed files. That
is already how a waiting task discovers a holder has finished; a milestone just
makes it happen sooner. Retry latency is the only delay, currently
`DEFAULT_PLAN_RETRY_MS` (15s).

### 4. The task's own remaining work

After a milestone lands, canonical has moved — by the task's own commit. The
task's remaining work is still based on the pre-milestone revision.

This is the fiddly part, but it is the *easy* case of a problem already solved.
`assessReplay` and `CanonicalAdvance` exist to answer "canonical moved, is my
work still applicable" and here the answer is trivially yes: the advance came
out of this very workspace, so the workspace already contains it. What has to
change is bookkeeping — the entry's `plannedVersion` and the base the final
change set is diffed against must move to the milestone's revision, or the
final integration will re-offer the milestone's own patches and the exact-base
check will fire on the task's own commit.

Get this wrong and every milestone-using task fails at the end. It deserves its
own test before anything else is built.

## What it costs

Worth pricing honestly before committing:

- **The auditor runs per canonical advance.** `pumpAuditor` triggers on
  `canonical_promoted`. A task that lands four milestones triggers four audits
  instead of one — a real, recurring spend increase, on an agent that already
  spends without being asked. Milestones may need to be excluded from audit
  triggering, or audited only on the task's final advance.
- **Validation runs per milestone.** For a repository whose test suite takes
  minutes, four milestones means four suite runs. Throughput gained in
  arbitration can be lost in validation.
- **One task becomes several commits.** `rollback.ts` maps tasks to commits;
  changeset records, `file_patches`, and the thread's "N files changed" summary
  all assume one change set per task. Each needs checking.
- **A partly-landed task that then fails** leaves its milestones in canonical.
  That is correct — they validated — but "the task failed" and "none of its work
  is in main" stop being the same statement, in the UI and in people's heads.

## Staging

1. **Base bookkeeping first**, with a test that a task landing one milestone
   still integrates its remainder cleanly. Nothing else matters if this is
   wrong.
2. **Refuse-only path**: emit and parse the event, always answer `refused`.
   Proves the protocol round trip with zero risk.
3. **Landing**, behind a project policy flag, single milestone per task.
4. **Lease narrowing** and the waiter pickup — the actual payoff, and the point
   at which the two-agent repro in `apps/cli/src/lease-referee.test.ts` should
   show the second task starting before the first has finished.
5. **Multiple milestones**, and only then consider removing the flag.

## A gap this exposes

The existing scope-change path arbitrates a widened plan against the in-run
`wave` and the in-memory `OwnershipService` only (`coordinator.ts:1534`). It
does not consult the durable `PlanAuthority`. So **mid-execution widening is
still cross-run blind** — the same class of bug the plan-lease fix just closed
for initial admission, still open one layer down: an agent can widen into a
file another run's task holds.

Milestone narrowing must go through the authority. The widening path should be
fixed at the same time; it is the same call, and finding it via this document
is cheaper than finding it via production.

## What not to do

- **Do not release without landing.** The top of this document is the whole
  argument, and it is the one mistake that undoes the referee.
- **Do not trust the agent's coherence claim.** Validate. The design is safe
  because a bad boundary is refused, not because agents pick good ones.
- **Do not add a notification channel** to tell waiters a lease narrowed. They
  already poll; adding a second path means two things that can disagree about
  who holds what.
