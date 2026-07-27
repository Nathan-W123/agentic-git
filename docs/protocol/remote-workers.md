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

## Not yet built

- The long-running worker daemon. The protocol, the control-plane operations,
  and workspace materialisation are implemented and tested; the poll loop that
  strings them together is a thin wrapper still to come.
- Container isolation on the worker side. `DockerWorkspaceManager` exists but
  has never run against a daemon, and hosted execution is exactly the case it
  is for: untrusted agents from different tenants on shared compute.
- Validation on workers. Integration still compiles and tests on the control
  plane, so a repository's own test commands run with control-plane privileges.
- Per-task credentials and an egress allowlist.
