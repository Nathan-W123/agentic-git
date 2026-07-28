# Remote Worker Protocol

Hosted execution splits the coordinator in two. The **control plane** owns
canonical state — scheduling, conflict detection, leases, and integration. A
**worker** owns nothing durable: it leases a task, materialises a workspace,
runs the agent, returns a changeset, and forgets.

Every endpoint is bearer-authenticated and requires the `run_task` scope, so a
read-only token cannot pull work or return results. See
[API tokens](api-tokens.md).

The protocol is versioned. Each assignment carries `protocolVersion`; this
document describes **version 2**, which is plan-first. A worker refuses to run
against a control plane advertising version 1 rather than silently falling back
to executing before its plan has been arbitrated.

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
| `approved_with_constraints` | Approved, with advisory overlap recorded | Execute, honouring `constraints` |
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

Results are held to the admitted plan, not to whatever plan the worker reports
alongside its changeset. A result whose reported plan claims resources the
admission never covered is refused, and the changeset is validated against the
admitted plan. A result on a lease with no approved admission is refused
outright.

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
| `POST` | `/api/v1/workers/register` | Announce a worker and its adapters |
| `GET` | `/api/v1/workers` | Fleet visibility |
| `POST` | `/api/v1/workers/leases` | Poll for work. `204` when idle |
| `POST` | `/api/v1/workers/leases/{id}/heartbeat` | Extend. `409 lease_lost` if lapsed |
| `GET` | `/api/v1/workers/leases/{id}/bundle` | Workspace contents as a Git bundle |
| `POST` | `/api/v1/workers/leases/{id}/plan` | Submit a plan for admission |
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

## Materialising a workspace

The control plane does not run a Git server. It packages the leased revision as
a **Git bundle** — one self-contained file the worker clones directly:

```bash
curl -H "Authorization: Bearer $TOKEN" .../bundle -o revision.bundle
git clone --branch "$BUNDLE_REF" revision.bundle workspace
```

Only the leased revision is included, so a worker never receives history it was
not assigned.

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

## What a worker never gets

- The canonical repository path, or any filesystem access to it
- History beyond the revision it was leased
- Another tenant's leases — every lease action verifies the worker belongs to
  the calling user, and returns `404` rather than `403` so lease ids cannot be
  probed

## The worker daemon

`apps/worker` implements the other half. It is configured entirely by
environment:

| Variable | Meaning |
| --- | --- |
| `COORD_SERVER` | Control plane URL |
| `COORD_TOKEN` | Bearer token carrying `run_task` |
| `COORD_PROJECT_ROOT` | Project supplying agent definitions |
| `COORD_WORKER_NAME` | Reported to the fleet listing |
| `COORD_REPOSITORY` | Restrict this worker to one repository |

Each iteration leases a task, fetches the bundle, clones it, has the agent
plan, gets that plan admitted, runs the agent, returns a changeset, and deletes
the workspace. It owns nothing durable.

Splitting planning from execution costs the worker nothing to arrange: both
adapters already separate them. `requestPlan` returns the agent's intent
without touching the workspace, and nothing is written until `sendContext`. The
worker simply holds the session between the two while the control plane
answers, and the agent is then told what it actually owns rather than a
placeholder approval.

Three behaviours matter. A **heartbeat runs alongside execution**, because an
agent can take far longer than the lease and the control plane would otherwise
reclaim work still in progress — it also runs while a deferred plan waits.
**Shutdown releases the held lease**, so a planned restart makes the task
available immediately rather than after the expiry. And a **deferred plan is
never a failure**: the task returns to the queue, and `IterationResult.deferred`
distinguishes it from work that went wrong.

A lost lease is never reported as a result: by then another worker may hold the
task, so the run is abandoned instead.

## Isolation

The worker honours the project's sandbox configuration, wrapping the agent in
`DockerWorkspaceManager` when one is set. With none configured the agent runs
unconfined, which is only defensible on a single-tenant worker.

The Codex adapter cannot currently be combined with a container sandbox — it
confines itself through Codex's own `--sandbox` flag rather than a
`WorkspaceSandbox` — so the worker refuses that combination rather than running
unconfined while appearing sandboxed.

## Not yet built

- Container isolation has still never run against a Docker daemon. Hosted
  execution is exactly the case it exists for: untrusted agents from different
  tenants on shared compute. `npm run verify:docker` covers it in one command.
- Validation on workers. Integration still compiles and tests on the control
  plane, so a repository's own test commands run with control-plane privileges.
- Per-task credentials and an egress allowlist.
- Human approval at admission time. The local coordinator gates a risky *plan*
  on a reviewer before granting a workspace; remotely, the approval gate still
  sits at the changeset. Moving it earlier would catch a high-risk plan before
  the agent runs, at the cost of a second blocking gate per task.
- Scope expansion mid-execution. A remote agent's `scope_change_requested` is
  refused rather than arbitrated, because the expanded scope was never admitted
  and no other holder had a chance to object. Handling it properly means a
  scope-change round trip against the same admission logic.
