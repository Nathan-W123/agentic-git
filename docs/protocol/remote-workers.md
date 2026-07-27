# Remote Worker Protocol

Hosted execution splits the coordinator in two. The **control plane** owns
canonical state — scheduling, conflict detection, leases, and integration. A
**worker** owns nothing durable: it leases a task, materialises a workspace,
runs the agent, returns a changeset, and forgets.

Every endpoint is bearer-authenticated and requires the `run_task` scope, so a
read-only token cannot pull work or return results. See
[API tokens](api-tokens.md).

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
| `POST` | `/api/v1/workers/leases/{id}/result` | Return a changeset or a failure |
| `POST` | `/api/v1/workers/leases/{id}/release` | Give the task back |

Idle returns `204` rather than an empty `200` so a polling worker branches on
the status code without parsing a body.

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

Each iteration leases a task, fetches the bundle, clones it, runs the agent,
returns a changeset, and deletes the workspace. It owns nothing durable.

Two behaviours matter. A **heartbeat runs alongside execution**, because an
agent can take far longer than the lease and the control plane would otherwise
reclaim work still in progress. And **shutdown releases the held lease**, so a
planned restart makes the task available immediately rather than after the
expiry.

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
