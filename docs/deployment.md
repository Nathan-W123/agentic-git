# Deploying the Coordinator Across Machines

The control plane is one process (API gateway, web control room, and the
integration engine) plus a place to keep state. Two kinds of state exist:

- **Coordination state** — organizations, users, tasks, leases, approvals,
  audit. Lives in SQLite by default, or in **PostgreSQL** when
  `COORD_DATABASE_URL` is set. Postgres is what lets several machines share
  one coordinator.
- **Canonical repositories** — bare Git mirrors and worktrees under the
  project directory (`COORD_PROJECT_ROOT/.coordinator`). These stay on the
  control-plane host; workers receive revisions as Git bundles over HTTP and
  never need filesystem access to them.

Browsers and workers on other machines only ever talk to the control plane
over HTTP on one port (default 4317).

## Quick start with Docker Compose

On the machine that will host the control plane:

```bash
POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
COORD_BOOTSTRAP_TOKEN="$(openssl rand -hex 24)" \
docker compose up --build -d
```

(Or put those two variables in a `.env` file next to `docker-compose.yml`.)
This starts Postgres and the control plane, stores the database in the
`coordinator-db` volume and canonical repositories in `coordinator-data`,
and listens on port 4317.

### First-run setup

The first account is created with the bootstrap token — once, before any
user exists:

```bash
curl -X POST http://<control-plane-host>:4317/api/v1/auth/bootstrap \
  -H "X-Bootstrap-Token: $COORD_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","displayName":"You","password":"<choose-a-password>"}'
```

The web control room at `http://<control-plane-host>:4317` offers the same
setup as a form when no user exists yet. After setup, the bootstrap token is
inert; sign in normally and manage users, organizations, and projects from
the web UI.

## Environment reference (control plane)

| Variable | Meaning | Default |
| --- | --- | --- |
| `COORD_DATABASE_URL` | `postgresql://` URL for shared coordination state. Unset means a local SQLite file — single-machine only. | unset |
| `COORD_PROJECT_ROOT` | Directory holding `.coordinator/` (config, canonical mirrors, worktrees). | working directory (`/data` in the container) |
| `COORD_HOST` | Listen address. Must be a reachable interface (e.g. `0.0.0.0`) for other machines to connect. | `127.0.0.1` (`0.0.0.0` in the container) |
| `COORD_PORT` | Listen port. | `4317` |
| `COORD_BOOTSTRAP_TOKEN` | First-run setup token, minimum 24 characters. Generated and printed on boot if unset — set it explicitly in real deployments. | generated |
| `COORD_SECURE_COOKIES` | `true` to mark session cookies Secure. Required when serving over HTTPS; leave `false` for plain-HTTP trials. | `false` |
| `COORD_ALLOWED_ORIGINS` | Comma-separated browser origins allowed CORS access, for a UI hosted on a different origin. | none |
| `COORD_REPOSITORY_PARALLELISM` | How many remote workers may hold leases in one repository at once. Concurrency is optimistic — every result integrates from its exact leased base or is requeued to replan — so raising this trades duplicate agent effort for throughput, never correctness. | `4` |

The same variables work without Docker: build with `npm ci && npm run build`,
then run `node apps/web/dist/index.js` under whatever supervisor you prefer.
Node.js >= 24 and `git` must be installed.

## Adding a worker on another machine

Workers execute leased tasks in isolated workspaces and return changesets.
They authenticate with a scoped API token, not a password.

1. In the web UI (or via `POST /api/v1/auth/tokens`), create a token with at
   least the `view` and `run_task` scopes — bound to one organization if the
   worker should serve only that tenant.
2. On the worker machine (Node.js >= 24, `git`, and Docker if the project
   uses the container sandbox):

```bash
npm ci && npm run build
cd path/to/an/empty/work/directory
node /path/to/repo/apps/cli/dist/index.js init   # local agent/sandbox config
COORD_SERVER=http://<control-plane-host>:4317 \
COORD_TOKEN=<api-token> \
node /path/to/repo/apps/worker/dist/index.js
```

Worker environment:

| Variable | Meaning | Default |
| --- | --- | --- |
| `COORD_SERVER` | Control-plane base URL. | required |
| `COORD_TOKEN` | API token with `view` + `run_task` scopes. | required |
| `COORD_PROJECT_ROOT` | Directory with the worker's `.coordinator/config.json` (agents, sandbox). | working directory |
| `COORD_WORKER_ROOT` | Where leased workspaces are materialized. | `.coordinator/worker` |
| `COORD_WORKER_NAME` | Display name in the workers list. | hostname-derived |
| `COORD_PROJECT_ID` | Only lease work for this project. | all projects the token can reach |
| `COORD_REPOSITORY` | Only lease work for this repository. | any |

A worker that shuts down cleanly releases its lease immediately; one that
dies simply stops heartbeating and the lease expires, so its task returns to
the queue either way.

## Project policy and budgets

Each project can carry a declarative policy, set by a project admin via
`PATCH /api/v1/projects/<id>` with a `policy` field (or cleared with
`"policy": null`). Both the local coordinator and remote result acceptance
evaluate it; a project without a policy uses the built-in defaults.

```json
{
  "version": 1,
  "approvals": {
    "requireChangesetReview": false,
    "riskLevels": ["high", "critical"],
    "protectedPaths": ["secrets/**", "infrastructure/production/**"],
    "approvalTimeoutMs": 86400000
  },
  "budgets": {
    "maxTaskRuntimeMs": 1800000,
    "maxProjectRuntimeMsPerDay": 28800000
  }
}
```

- `approvals` controls when a changeset needs a human: always, by risk
  level, or when protected paths are touched. `protectedPaths` *replaces*
  the default protected set when present.
- `budgets` are runtime cost controls for remote execution. A task past
  `maxTaskRuntimeMs` is failed at its next heartbeat; a project past its
  rolling 24-hour `maxProjectRuntimeMsPerDay` stops receiving workers —
  queued tasks wait rather than fail. Budgets are throttles, not hard
  accounting: two workers leasing at the same instant can overshoot by at
  most one task's runtime.

## Production notes

- The control-plane image contains no Docker CLI, so the containerized
  control plane cannot run sandboxed tasks itself (`/api/v1/health` reports
  `docker.available: false`). That is the intended shape: task execution
  belongs on workers, which honor the project's container sandbox on their
  own machines.

- Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of
  port 4317 and set `COORD_SECURE_COOKIES=true`. The control plane itself
  speaks plain HTTP.
- Back up both the Postgres database **and** the `coordinator-data` volume;
  the store holds coordination history while the volume holds the canonical
  Git mirrors. They must be backed up and restored together.
- The coordination-store schema migrates itself on startup; run one control
  plane instance at a time (migrations are advisory-locked, but the process
  itself is not yet HA).
- `COORD_TEST_POSTGRES_URL` and `COORD_SKIP_POSTGRES_TESTS` affect only the
  test suite, never a running deployment.
