# Remote Worker Protocol

Hosted execution splits the coordinator in two. The **control plane** owns
canonical state — scheduling, conflict detection, leases, and integration. A
**worker** owns nothing durable: it leases a task, materialises a workspace,
runs the agent, returns a changeset, and forgets.

Every endpoint is bearer-authenticated and requires the `run_task` scope, so a
read-only token cannot pull work or return results. See
[API tokens](api-tokens.md).

There is a second way a task gets done, with no worker process at all: an
editor connected over MCP takes it and does it in the checkout the person
already has open. That path shares the lease, the admission and the
integration described here, and differs in when the plan is admitted and how
long a hold lasts. See [doing Kumi's work from an editor](editor-work.md).

The protocol is versioned in both directions. Each assignment carries the
control plane's `protocolVersion`, and a worker announces its own in the body
of `POST /workers/leases`. This document describes **version 4**:

- **2** is plan-first. A worker refuses to run against a control plane
  advertising version 1 rather than silently falling back to executing before
  its plan has been arbitrated.
- **3** lets a claim on the whole repository be narrowed while it is held, so
  a control plane only grants one to a worker announcing 3 or later.
- **4** lets an assignment carry `mcpServers` — the project's approved MCP
  servers, secrets opened, for the one machine allowed to run them. A control
  plane withholds them from a worker announcing anything older and records
  that it did.

The floor a worker holds a control plane to is **3**, not its own version:
everything 4 added is optional, and a control plane one release behind simply
never sends it. Refusing it would strand every desktop that updated before the
server did.

## Plan first, then execute

A remote worker does not start editing when it gets a lease. It plans, submits
that plan, and waits for the coordinator's answer:

```
lease -> bundle -> requestPlan -> POST .../plan -> execute -> result
                                        |
                                        +-- blocked / sequenced --> wait or requeue
```

This mirrors what the local coordinator has always done between an agent's
`requestPlan` and its `sendContext`, and it exists for a plain economic reason.
A repository admits several concurrent leases (`COORD_REPOSITORY_PARALLELISM`),
so two workers can hold the same base at the same time. Without admission, both
run an agent to completion and the loser's changeset is rejected at
integration — correct, but the compute and the agent spend are gone. With
admission, the loser is stopped after one planning round trip, while its agent
is still idle.

The answer is one of four, mirroring the Agent Planning Protocol:

| Status | Meaning | What the worker does |
| --- | --- | --- |
| `approved` | No structural conflict; ownership granted | Execute |
| `approved_with_constraints` | Approved, with advisory overlap or a partial grant recorded | Execute, honouring `constraints` |
| `sequenced` | Executing work holds these resources | Wait `retryAfterMs`, resubmit |
| `blocked` | Not separable by ordering, or the base moved | Plan again |

`blocked` with `requeue: true` means canonical advanced under the plan. The
control plane has already released the lease and requeued the task, so the
worker re-leases at the new revision and plans afresh. That is the same
replan-on-canonical-change the local coordinator performs between waves,
happening at the cheapest possible moment.

A deferred worker keeps its lease and resubmits the *same* plan — a bare HTTP
call, not another agent invocation. It gives the lease back once its wait
budget is spent, so a blocked task cannot hold a repository concurrency slot
indefinitely.

### How the decision is made

Admission does not have its own conflict rules. It runs the candidate plan
through the same `ConflictDetector` and `OwnershipService` the local wave
scheduler uses, against the plans on every other active lease in the
repository that has been approved:

- Structural conflict evidence sequences the plan behind the tasks it collides
  with. Intent evidence is advisory and never blocks; it comes back as a
  constraint.
- A `block` disposition refuses the plan outright, because ordering would only
  relocate the collision.
- Ownership is the finer check: exclusive file and symbol claims collide, while
  shared (prose, tests) and intent-mode (APIs, configuration, services)
  resources do not. A plan's own declared schemas are the approval for claiming
  them, exactly as locally.

### Partial admission

Leases are per-resource, and so is this decision. When the whole plan is
refused, admission asks a second question: is *some* of it free right now? A
plan naming five files and colliding on one has four files nobody is touching,
and making it wait for all five is throughput given away for no safety gained.

The contested files are dropped and the remainder goes through the same
arbitration as any other plan. Partial admission chooses what to ask, never the
answer — a remainder that still collides falls back to the all-or-nothing
refusal. What comes back is `approved_with_constraints` carrying
`deferredResources`: which resources were withheld, who holds them, and why.

Files are withheld first, because a file can always be held to: a patch on a
file that was not granted is refused on its path alone. A withheld file takes
its enriched claims with it — the symbols, APIs and schemas that no *granted*
file accounts for — because those exist in the plan only by virtue of it, and
leaving them behind would have the reduced plan asking for exactly what the
other holder owns.

When dropping the contested files is not enough, a **symbol** can be withheld
while the file holding it is granted. That needs the repository index to say
which lines the symbol occupies at the base revision, which is the same
coordinate system the old side of a diff hunk is measured in. The patch body is
walked — not just the hunk header, whose context lines are not changes — so a
hunk is judged by the lines it changes rather than by the context it carries.
Those line ranges travel on the decision as `locations`, so the agent is told
which lines of a file it otherwise owns are not its to edit, and the same
ranges are what the result is held to.

A patch that reaches into a withheld symbol is **divided at the hunk**, not
lost whole. The hunks clear of the withheld lines are a valid patch against the
same base revision — no hunk is rewritten, only renumbered on the new side,
which is the side renumbering is defined for — so they are promoted while only
the trespassing hunks are held back. On this repository's own history, the
hunks that used to be discarded alongside a trespassing one account for
[54–75% of the changed lines](../benchmarks/partial-admission-granularity.md)
in a contested file.

Division is refused rather than guessed at wherever the patch is not a plain
single-file modification the parser fully recognises: a binary patch, a
multi-file patch, a `\ No newline at end of file` marker, a header whose counts
disagree with its body, or a file being added or deleted. Those fall back to
losing the file, as before. Hunks are also not independent — a rename in one
and its call sites in another are one change — so a division can produce a
granted half that does not build. That is caught where every other broken
changeset is caught: the granted half is validated transactionally before
promotion, and a failure leaves canonical untouched.

What is *not* divisible is a contested **file**. See
[the granularity note](../benchmarks/partial-admission-granularity.md#what-is-still-withheld-whole-and-why)
for why withholding a line range of a file the other holder owns outright
cannot be made sound without changing what a file lease means.

Enforceability is the limit throughout. A symbol is only withheld when *every*
file still being granted can be parsed; one unreadable file among them and the
plan waits instead, because an instruction the control plane cannot check is
not one. At result time the same rule fails closed: if the positions are
missing when they are needed, the patch is held back rather than promoted on
the assumption that it was fine.

The worker executes normally. It passes the withheld set to its agent as
constraints on the decision, before any editing, which is the only point where
a real agent can absorb a scope change. Enforcement does not depend on the
agent obeying:

- Patches inside the granted scope are promoted.
- Patches on a withheld file are held back — never applied, never carried
  forward. They were written against a file another task is mid-rewrite of.
- A patch on a file in neither set is the scope escape it always was, and the
  result is refused.
- A result consisting only of withheld patches has nothing to promote, so the
  task is released back to the queue at full scope rather than failed.

Once the granted part is durably in canonical, the withheld part is submitted
as a task of its own, marked so that it is arbitrated whole. That marker is the
termination argument: a task sheds scope at most once, instead of shedding one
file per round and paying for an agent run each time. A granted file whose
patch was dropped for reaching into a withheld symbol is named in the follow-up
too, or its other edits would be quietly gone.

The held-back patches are kept with that follow-up rather than discarded,
bounded so one runaway changeset cannot bloat the audit log, and each patch is
kept whole or recorded by name only. They are never replayed: they were written
against a file another task is in the middle of rewriting, and applying them to
whatever it becomes would be publishing a change nobody re-read. What they are
for is the agent that picks the follow-up up, which starts from what was
already worked out instead of from nothing.

The cost is the one repository parallelism already accepts. Partial admission
turns "the second task waits" into "the second task runs concurrently", so the
two now race to integrate. The loser is not automatically thrown away — see
below — but it may still be requeued, and that trade is only ever taken where
concurrent leases were already enabled: at `COORD_REPOSITORY_PARALLELISM=1` no
two plans are ever active in one repository, and partial admission never fires.

### A result can outlive its base

Exact-base integration refuses every result whose base has been overtaken. That
is the right default, but on its own it is blunt: the integration workspace is
built from *current* canonical and the patches are applied three-way, so a
result overtaken by work it has nothing to do with would apply perfectly well.
Refusing it discards a finished agent run to prevent a collision that did not
happen.

So before requeueing, the control plane asks whether the advance actually
concerned this result — whether it touched a file the result writes, a resource
the plan claimed, or anything the plan **depends on**. The last is the one that
matters: an agent that read a module and wrote code against it is invalidated
when that module changes, whether or not it edited it, and enrichment resolves
imports into `file:` and `symbol:` dependency entries precisely so that is
visible. Only an advance that touched none of those is replayed.

Permission is pinned to one revision rather than passed as a flag, so canonical
moving once more between the check and the integration leaves them unequal and
the result is refused as stale. Everything that made remote results safe is
untouched: the three-way apply, the comparison of applied against declared
entries, and the compare-and-swap promotion all still run, and anything that
cannot be ruled out still takes the requeue-to-replan path. The integration
record carries `replayedFrom` so the history shows a result outlived its base
rather than hiding it behind an ordinary promotion.

Being refused as stale is not the end of the question, though, because staleness
is the one integration outcome that is not a fact about this result: it says
another task reached canonical first. Asked only before integrating, the replay
question misses every result that loses that race — and the window is not
narrow. The common way to lose it is the compare-and-swap at the end of
promotion, which means losing *after* a full validation run, so any two tasks
finishing within a validation run of each other put one of them here. That was
an unconditional replan no matter how unrelated the two changes were.

So a stale result is graded once more, against the advance that beat it, now
that the advance has completed and can be read. This widens *when* the question
may be asked and nothing else: it is the same assessment against the same base,
so a semantic blocker still requeues unconditionally and only a purely textual
overlap reaches the free merge, still pinned to one exact revision. The budget
is one retry (`STALE_REASSESSMENT_BUDGET`), because each costs another
validation run; exhausting it lands on the same requeue the path took before,
which is the floor the mechanism can never fall below. Traces taken on this
path carry `afterLosingRace` so the history distinguishes a result that was
overtaken before it started from one that was overtaken while integrating.

That floor is why a result which reached integration only by being re-graded is
requeued, never failed, when the merged tree conflicts or fails validation. It
used to be requeued without being validated at all; now that it does get
validated, a failure must not turn a task that would have been retried into a
dead one. Results assessed *before* integrating keep the narrower rule — with
no textual overlap the advance is unrelated, so a validation failure is the
agent's own and a replan would only rediscover it.

Arbitration is serialized in the database, not in application code. The write
that records an admission carries the set of already-admitted leases it was
decided from, and is refused if that set has changed — so two workers
arbitrating overlapping plans at the same instant cannot both be approved. The
loser recomputes against the winner.

### Admission is not the safety mechanism

It reduces waste. What makes a remote result safe is unchanged: integration
requires the exact base the lease was issued at, and a result whose base moved
is requeued to replan rather than merged. Admission runs in front of that
backstop and never in place of it.

A claim frozen from observation is re-arbitrated before it is enforced. The
directories a freeze carries are what let its holder write there without
asking, but arbitration stopped treating them as a hold, so a path under one
may have been granted to somebody else since. Anything the changeset touches
that the claim permits but no longer occupies goes back through the same
admission every mid-run widening does: still free, and it is granted and
recorded as a revision; held by somebody else, and the result is refused. The
local coordinator has always done this; the remote path does now too.

Results are held to the admitted plan, not to whatever plan the worker reports
alongside its changeset. A result whose reported plan claims resources the
admission never covered is refused, and the changeset is validated against the
admitted plan. A result on a lease with no approved admission is refused
outright.

Under a partial admission the admitted plan is the *reduced* one, so the same
sentence carries the stronger guarantee: no patch can reach canonical against a
resource the task was not granted. A reported plan may still name a withheld
resource — the worker declared it honestly and the coordinator is what narrowed
it — but declaring is not writing, and only the granted patches are applied.

## The lease is the recovery mechanism

A task is handed to exactly one worker for a bounded time. A unique partial
index enforces at most one `active` lease per task in the database rather than
in application code, so two workers can never hold the same task.

```
submitted --lease--> active --result--> completed | failed
                       |
                       +--release / expire--> submitted
```

A worker that crashes stops heartbeating. The lease lapses, the task returns to
the queue, and another worker picks it up. Without an expiry a dead worker
strands its task permanently, which is why the lease — not the poll — is the
core of this protocol.

Leases last five minutes and are extended by heartbeat. Every lease request
first sweeps expired leases, so recovery needs no separate reaper process.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/workers/register` | Announce a worker, its organization, and its adapters |
| `GET` | `/api/v1/workers?organizationId=…` | Fleet visibility, organization-wide |
| `POST` | `/api/v1/workers/leases` | Poll for work. `204` when idle |
| `POST` | `/api/v1/workers/leases/{id}/heartbeat` | Extend. `409 lease_lost` if lapsed |
| `GET` | `/api/v1/workers/leases/{id}/bundle` | Workspace contents as a Git bundle |
| `POST` | `/api/v1/workers/leases/{id}/plan` | Submit a plan for admission |
| `POST` | `/api/v1/workers/leases/{id}/scope` | Ask to widen the admitted scope mid-run |
| `POST` | `/api/v1/workers/leases/{id}/result` | Return a changeset or a failure |
| `POST` | `/api/v1/workers/leases/{id}/release` | Give the task back |

Idle returns `204` rather than an empty `200` so a polling worker branches on
the status code without parsing a body.

`POST .../plan` takes `{ "plan": AgentPlan }` and returns
`{ "admission": PlanAdmission }`. It answers `409 lease_lost` when the lease has
lapsed, and `400 invalid_plan` when the plan is unusable — malformed, for
another task, or against a different objective than the one leased. An
unusable plan fails the lease rather than requeueing it, because the same plan
would be rejected again on the next attempt.

`POST .../scope` takes `{ "request": ScopeChangeRequest }` and returns
`{ "decision": ScopeChangeDecision }`. See
[Scope expansion mid-execution](#scope-expansion-mid-execution).

`POST .../heartbeat` optionally takes `{ "tokenUsage": AgentTokenUsage[] }`,
and `POST .../result` accepts the same field. See
[Cost controls](#cost-controls).

## Who can see a worker, and who can drive it

A worker belongs to an organization, chosen at registration and fixed
thereafter. `POST /workers/register` requires `organizationId` and authorizes
it, so a token confined to one organization cannot enrol a machine into
another.

Visibility and control are deliberately different widths:

- **Visibility is organization-wide.** `GET /workers?organizationId=…` returns
  every worker the organization operates, with the active leases each is
  holding, to any member with `view`. A fleet is shared infrastructure; a team
  that cannot see which machine is holding a task cannot reason about its own
  queue. The `own` flag on each row marks the caller's own workers.
- **Control stays with the registering user.** The lease endpoints still
  require `worker.userId` to be the caller. Seeing that a colleague's desktop
  is busy is useful; being able to pull work onto it is not, and the worker
  executes under its owner's credential.

Leasing additionally requires the worker's organization to match the project's.
Visibility widened within a tenant; execution did not widen across one. A user
who belongs to two organizations could otherwise aim a worker registered in one
at the other's queue, and the resulting workspace, bundle, and changeset would
put that tenant's code on a machine it never admitted to its fleet. The
mismatch answers `403 worker_organization_mismatch`.

Naming no organization on the read endpoints is a `400`, not a default. An
endpoint that inferred the tenant would answer a request that never identified
one, and would have no single value to bound the query by — which is how a
fleet listing ends up merging tenants.

## Human approval at admission time

A project can move its review gate from the changeset to the plan by setting
`approvals.requireRemotePlanReview`. The reasons are unchanged — the plan's
risk level, a schema claim, a protected path — so a plan that would stop the
local scheduler now also stops a remote worker, before the agent runs rather
than after.

A gated plan comes back `sequenced` with `awaitingApproval: true` and the
`approvalId` a reviewer will decide. The worker keeps its lease, keeps
heartbeating, and resubmits, switching from its ordinary deferral budget to
`planApprovalWaitMs` — waiting for a person is not the same wait as waiting
for another worker's lease, which clears in seconds. Resubmission is
idempotent: the same approval, never a second one queued behind the first.

An approved plan proceeds to ordinary arbitration. A rejected or expired one
fails the lease and the task, because a reviewer's "no" is not a transient
condition to retry through.

The gate opens the task's run early — an approval has to belong to one — and
the admission carries that `runId` forward so the result reuses it rather than
splitting one task's history across two records. A plan waiting on a reviewer
is therefore visible in run history while it waits, instead of appearing only
once the work is finished.

The cost is a second blocking gate per task, and a worker holding a repository
concurrency slot while a person is asked. That is why it is off by default.

## Scope expansion mid-execution

A remote agent that discovers it needs a file outside its admitted plan asks,
and the coordinator arbitrates. The worker cannot answer this itself — it has
no view of what other tasks own — so it forwards the request and the control
plane runs the widened plan through the same `ConflictDetector`,
`OwnershipService`, and `PlanAdmissionController` an initial admission uses,
against the plans on every other active lease.

| Decision | Meaning | What the agent does |
| --- | --- | --- |
| `approved` / `approved_with_constraints` | Nothing else holds the resources | Continue with the wider plan |
| `deferred` | Another executing task holds them | Continue in current scope; ask again after `retryAfterMs` |
| `rejected` | Ordering cannot separate the two, or a reviewer said no | Continue in current scope |

A deferral names its holders in `blockedBy`. It is deliberately distinct from
a refusal: the resource will be free later, and telling an agent "never" when
the truth is "not yet" throws away work it could still do.

A grant replaces the admitted contract on the lease with the revised plan.
That replacement is the one write allowed to overwrite an approved admission,
and it carries the same compare-and-swap check every admission does, so a
rival admitted between the decision and the write invalidates it and the
answer comes back as a deferral instead. Nothing about result enforcement
relaxes: the contract is widened *before* the edits arrive, so the changeset
is still split and checked against a scope the control plane issued, and a
patch outside it is still refused.

The project's approval policy still applies. A scope expansion touching a
schema or a protected path waits for a reviewer, and the request stays open
while it does — the same way a gated changeset does. An expansion that needs
a reviewer on a task with no run is refused rather than waved through, since
there is nowhere to record the request.

## Cost controls

Model spend is accounted per task and per project, and capped.

Reporting is the agent's and is optional throughout: the Codex adapter parses
the figure the CLI prints, and a generic-CLI agent may attach
`{"tokens": {"total": n}}` to its `done` message. An agent that reports
nothing is recorded as having reported nothing — an invented figure would be
worse than an absent one, because a budget would then be enforced against
fiction.

The worker sends the running total up with its heartbeat, and the final figure
with its result. Each report carries a cumulative per-phase total rather than
an increment, and the store keys on `(lease, phase)` and replaces, so the
recorded bill tracks what was spent rather than how often the worker happened
to heartbeat.

Two budgets sit alongside the two runtime ones in
`budgets` (see [deployment](../deployment.md)):

| Budget | Enforced at | Effect |
| --- | --- | --- |
| `maxTaskTokens` | Heartbeat | The lease and task fail — while the spending is still happening |
| `maxProjectTokensPerDay` | Lease | The project stops receiving workers; tasks stay queued |

Enforcing the per-task cap at heartbeat rather than at the result is the whole
point: by the time a result exists the tokens are gone, and failing finished
work over its bill would waste the very thing the budget protects. The result
endpoint therefore records the final spend without enforcing anything.

Tokens and runtime are separate limits because they answer different
questions — a task can be quick and expensive, or slow and cheap — so neither
substitutes for the other.

## Materialising a workspace

The control plane does not run a Git server. It packages the leased revision as
a **Git bundle** — one self-contained file the worker clones directly:

```bash
curl -H "Authorization: Bearer $TOKEN" .../bundle -o revision.bundle
git clone --branch "$BUNDLE_REF" revision.bundle workspace
```

The bundle advertises only the leased ref, not the current canonical tip or
unrelated branches. Git bundles necessarily include ancestors reachable from
that revision so the worker can materialize a valid repository.

Two details are load-bearing. Git refuses to bundle a bare commit — a bundle
carries refs, not commits — so the control plane creates a short-lived branch
naming the revision, bundles that, and deletes it. This matters because
canonical may advance while a worker holds its lease, and the worker must
receive the revision it was *assigned*, not the current tip. The ref name is
derived from the lease id, so concurrent bundle requests cannot collide, and it
is returned as `bundleRef` in the assignment.

## Returning a result

A completed result must carry a changeset whose `baseRevision` matches the
revision the lease was issued against, and whose `taskId` matches the lease. A
worker that built from a different revision is reporting work the control plane
cannot safely integrate, and it is rejected rather than accepted and discarded
later.

A result on a lapsed lease is refused. By then another worker may hold the
task, and accepting both would let two workers write results for one task.

## MCP servers on the lease

Since protocol 4 an assignment may carry `mcpServers`: the project's approved
MCP servers, each as `{ name, transport, command?, args?, env?, url?, headers? }`
with its secrets already opened into `env` (stdio) or `headers` (http). The
control plane only attaches them when every one of these holds, and writes an
audit event naming which failed when it does not:

- `COORD_MCP_ENABLED=1` on the control plane and the server approved in
  Settings (approval is a recorded act, separate from creating it)
- the server's scope covers the task's repository
- the worker announced protocol 4 or later on its lease request
- the worker's owner is the owner of the agent the task was mentioned to, so
  the secrets are being handed to the one person allowed to run with them
- the sealing key is present, and every secret opens with it

Nothing in that list starts anything. The worker applies its own allowlist
(`mcp.allow` in the project file: `"all"`, or a list of `{ name, digest }`
entries, absent meaning run nothing), writes what survives into the run's
scratch directory beside the workspace — never into it, where the changeset
would commit it — and hands the file to the vendor CLI. The digest is
computed by the worker from what the lease carried — the command and
arguments or URL, and the names of the secrets — so a server the project
redefines after the owner allowed it is withheld again, and said to have
changed. What was withheld is posted into the thread and offered to the
desktop app, which shows the owner what each server runs or talks to before
asking; the app's Agents menu can take every yes back.

## What a worker never gets

- The canonical repository path, or any filesystem access to it
- Newer canonical revisions or unrelated branch refs. Ancestors reachable
  from the leased revision are present because Git needs them to clone it.
- Another tenant's leases — every lease action verifies the worker belongs to
  the calling user, and returns `404` rather than `403` so lease ids cannot be
  probed
- Another person's MCP secrets — a lease whose worker owner is not the
  mentioned agent's owner is served without `mcpServers`, whatever the
  project approved

## The worker daemon

`apps/worker` implements the other half. It is configured entirely by
environment:

| Variable | Meaning |
| --- | --- |
| `COORD_SERVER` | Control plane URL |
| `COORD_TOKEN` | Bearer token carrying `run_task` |
| `COORD_ORGANIZATION` | Organization this worker registers into |
| `COORD_PROJECT_ROOT` | Project supplying agent definitions |
| `COORD_WORKER_NAME` | Reported to the fleet listing |
| `COORD_WORKER_CONCURRENCY` | How many tasks this machine runs at once |
| `COORD_REPOSITORY` | Restrict this worker to one repository |

Each iteration leases a task, fetches the bundle, clones it, has the agent
plan, gets that plan admitted, runs the agent, returns a changeset, and deletes
the workspace. It owns nothing durable.

Iterations run together rather than one after another. The daemon takes one
lease at a time — the repository's parallelism bound is counted across active
leases, so asking for a batch would ignore it — but starts looking for the
next as soon as the previous one *has* its lease, rather than when it has
finished with it. Everything a run owns while it holds a lease is its own: its
agent session, its blanket claim, its admission wait and the plan it finally
reports. The one thing runs share is this machine's cache of the repository,
and work on that is serialised per repository, because concurrent fetches into
one bare repository lose a ref lock and the loser's recovery is to delete the
cache the winner is still reading.

Splitting planning from execution costs the worker nothing to arrange: all
shipped adapters separate them. `requestPlan` returns the agent's intent
without touching the workspace, and nothing is written until `sendContext`. The
worker simply holds the session between the two while the control plane
answers, and the agent is then told what it actually owns rather than a
placeholder approval.

Three behaviours matter. A **heartbeat runs alongside execution**, because an
agent can take far longer than the lease and the control plane would otherwise
reclaim work still in progress — it also runs while a deferred plan waits, and
carries the agent's running token total with it. **Lease loss or shutdown
actively cancels the agent and releases the held lease**, so withdrawn work
stops and a planned restart makes the task available immediately rather than
after the expiry. And a **deferred plan is never a failure**: the task returns
to the queue, and `IterationResult.deferred` distinguishes it from work that
went wrong.

A lost lease is never reported as a result: by then another worker may hold the
task, so the run is abandoned instead.

## Isolation

The worker honours the project's sandbox configuration, wrapping the agent in
`DockerWorkspaceManager` when one is set. With none configured the agent runs
unconfined, which is only defensible on a single-tenant worker.

**This is verified live, not merely implemented.** `npm run verify:remote-docker`
starts a real control plane on a real port, registers a real worker daemon,
and drives one task through the whole protocol — lease, bundle, clone, plan,
admission, containerized execution, result, validation, promotion — against a
live Docker daemon. It asserts confinement from *inside* the container rather
than from the flags the host passed: with `COORD_SANDBOX_PROBE=1` the
reference agent probes its own surroundings and reports the verdicts in its
completion explanation, which travels with the changeset and is persisted. A
run that integrates therefore carries its own evidence:

```
[PASS] the containerized agent reported denied network, read-only root, and
       masked git - rootfs=readonly git=masked network=denied
```

### Why the vendor CLIs stay on the host

Only generic-CLI agents get container confinement. Codex, Claude Code, and
Gemini CLI run on the worker host under their own vendor sandboxing, and the
worker refuses to combine them with a Docker sandbox rather than running
unconfined while appearing sandboxed. That refusal is not an oversight, and it
is not merely a packaging problem:

1. **The sandbox denies egress; the CLIs require it.** The container runs
   `--network none`, and a DNS lookup for a vendor endpoint inside it fails
   with `EAI_AGAIN`; the same lookup on a bridged network resolves. A vendor
   CLI with no route to its provider's API cannot do anything at all. A
   project *can* set `sandbox.network`, but that trades deny-default egress
   for unrestricted egress, which is strictly worse than the status quo: the
   vendor CLI's own sandbox at least confines the filesystem. Closing this
   properly needs the per-task egress allowlist below, not a wider network.
2. **Their credentials are host login state.** All three authenticate against
   the CLI's own session in the user's home directory. The container has a
   read-only root, no home, and does not inherit host environment variables —
   deliberately. An API key can be injected today through an agent's `env`
   block, which becomes `--env` on the container, so an API-key deployment is
   reachable; a subscription login is not, and making it reachable would mean
   mounting a long-lived credential store into a container running untrusted
   agent code.
3. **Codex would be doubly sandboxed.** It confines its edit phase through its
   own `--sandbox workspace-write`, which needs a platform sandbox backend.
   Inside a container with `--cap-drop ALL` and `--security-opt
   no-new-privileges` that either fails or has to be disabled, at which point
   the container is the only sandbox and Codex's flag is decoration.

The egress allowlist and the scoped credential mounts both now exist, and the
double-sandboxing question above is resolved: see
[vendor CLI sandboxing](../architecture/vendor-cli-sandboxing.md) for the
mechanism, the argument for disabling Codex's own sandbox inside a container,
and the precondition that argument depends on.

The adapters still refuse, because the wiring turned out to be less mechanical
than this note assumed. `CodexAdapter` and the prompt-cli adapters do not accept
a `WorkspaceSandbox` at all — only `GenericCliAdapter` does — and Codex writes
its `--output-schema` file to a host temp directory the container cannot see,
which needs a mount surface that does not exist yet.

### Where validation runs

Integration compiles and tests on the control plane, but **not as the control
plane** when a sandbox is configured: `workerOperations` builds its
`IntegrationService` on the same `DockerWorkspaceManager` the agents use, so a
repository's own commands run in a container with a read-only root, no
network, and only the candidate worktree mounted. The live verification above
covers this too — it runs `node --test` over the candidate tree, including the
test file the agent added, inside the reference image.

Two honest limits remain. Without a configured sandbox, validation still runs
as the control-plane process. And validation runs on the control-plane *host*
rather than on the worker, because the tree being validated does not exist
anywhere else: it is the three-way merge of the result onto current canonical,
which only the control plane can build. Shipping that merged tree back to a
worker to test would mean handing a worker canonical content it is
specifically not given, and trusting its self-reported pass — which is a
weaker guarantee than running it under confinement here, not a stronger one.

## Not yet built

- Adapter wiring for the containerized vendor CLIs. The per-task egress
  allowlist and the scoped credential mounts they depended on are built; see
  [vendor CLI sandboxing](../architecture/vendor-cli-sandboxing.md) for what
  remains.
- Validation executed by the worker itself, as opposed to under confinement on
  the control-plane host. See the limits above.
- Cost accounting beyond tokens: no per-model pricing, invoicing, or billing
  integration. What exists is token counts and caps.
