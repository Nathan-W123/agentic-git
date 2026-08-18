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
| `COORD_SECURE_COOKIES` | `true` to force the Secure flag on session cookies. Cookies are marked Secure automatically on any request that arrived over TLS (directly, or via `X-Forwarded-Proto` when `COORD_TRUSTED_PROXY_HOPS` is set), so this is only needed to force it on; leave it unset for plain-HTTP trials, where forcing it stops sign-in working at all. | `false` |
| `COORD_ALLOWED_ORIGINS` | Comma-separated browser origins allowed CORS access, for a UI hosted on a different origin. | none |
| `COORD_CREDENTIAL_KEY` | Encrypts users' stored provider credentials. 32 bytes as base64 or hex; anything else is stretched with scrypt. Generated once beside the credential file if unset, which ties the credentials to that directory — set it explicitly in real deployments. Read once at boot and then removed from the process environment, so nothing the control plane spawns can see it. | generated |
| `COORD_CREDENTIAL_POLICY` | What a task does when its submitter has connected no provider account: `refuse` fails the task, `host-login` falls back to the machine's own CLI login. `refuse` is the default because the fallback is silent — one person's task spends the host owner's subscription and nothing in the run says so. **A single-operator deployment where nobody has connected a provider account needs `host-login`, or its tasks stop running.** See [per-user provider accounts](architecture/per-user-credentials.md). | `refuse` |
| `COORD_ALLOW_REGISTRATION` | Set to `0` to close self-service sign-up at `/api/v1/auth/register`. A new account owns its own organization and can run tasks, so close registration on a deployment strangers can reach unless that is intentional. Invitations are unaffected. `COORD_DISABLE_REGISTRATION=1` still closes it explicitly. | open |
| `COORD_SMTP_URL` | Relay used to send registration confirmation codes and "forgotten password" links: `smtp://user:password@host:587` (STARTTLS when the relay offers it) or `smtps://host:465` (TLS from the first byte). Percent-encode an `@` in the password. Unset means messages are written to the control plane's log instead, which is a usable path for a single-operator deployment and no answer at all for a shared one. | unset |
| `COORD_MAIL_FROM` | `From` address on those messages, display name allowed (`Lattice <no-reply@example.com>`). Unset means `no-reply@<SMTP host>`, which most relays refuse to send as — set the address the relay has authorised. | `no-reply@<SMTP host>` |
| `COORD_PUBLIC_URL` | Absolute origin this deployment is reached at, used to build the reset link. Unset falls back to the `Host` header of the request that asked for the link — correct behind a router that sets it, wrong wherever a client can choose it. | inferred from `Host` |
| `COORD_PASSWORD_RESET_TTL_MINUTES` | How long a reset link stays usable. Requesting a new link always invalidates the previous one, whatever this is. | `60` |
| `COORD_TRUSTED_PROXY_HOPS` | How many proxies sit in front of this control plane. `0` ignores `X-Forwarded-For` and treats the socket peer as the client. Behind a platform router that means every request shares one rate-limit bucket, so one client can exhaust the ten-per-minute sign-in budget for everybody — set this to the real number of hops. Setting it higher than the truth lets a client choose its own bucket, so it is never inferred. Also what makes `X-Forwarded-Proto` trusted for the Secure-cookie and HSTS decisions. | `0` |
| `COORD_HSTS` | `Strict-Transport-Security` lifetime in seconds, sent only on requests that arrived over TLS. Empty means one year; `0` turns it off. Browsers remember it for the domain, so turn it off before ever serving that domain over plain HTTP. | one year |
| `COORD_SANDBOX_USER` | `UID:GID` the Docker sandbox runs containers as, when the project config names no `sandbox.user`. Empty means the user the control plane itself runs as — which owns the worktree being bind-mounted, so files the agent writes stay writable. Set it only for an image whose entrypoint needs root. | this process's UID:GID |
| `COORD_GITHUB_CLIENT_ID` | Client ID of a GitHub OAuth App with **Enable Device Flow** ticked (github.com → Settings → Developer settings → OAuth Apps). Turns on "Sign in with GitHub" when connecting the push credential in Settings; the device grant needs no client secret. Unset, connecting GitHub means pasting a personal access token. See [per-user provider accounts](architecture/per-user-credentials.md). | unset |
| `COORD_REPOSITORY_PARALLELISM` | How many remote workers may hold leases in one repository at once. Concurrent workers are separated at plan time: each submits its plan before editing and a colliding plan is sequenced rather than executed. Correctness does not depend on this setting — every result still integrates from its exact leased base or is requeued to replan — so raising it trades a little planning overhead for throughput. | `4` |
| `COORD_MAX_CONVERSATION_SESSIONS` | How many conversational tasks may hold a live agent session between turns. A held session is a held CLI process, so this is the memory a machine spends on warm conversations. Past the cap the conversation whose turn landed longest ago gives its session up; it stays open and its next turn starts cold in the directory it kept. See [conversational tasks](architecture/conversational-tasks.md). | `8` |
| `COORD_CONVERSATION_SESSION_IDLE_MS` | How long a conversation's session may sit idle between turns before it is closed. Same trade as the cap, measured in silence rather than in count, and the conversation survives it either way. | `900000` (15 minutes) |
| `COORD_OPEN_CONVERSATION_MAX_AGE_MS` | How long a landed conversational task waits for its next message before the waiting ends and the task is settled. The work stays landed — only the thread stops being continuable, and its workspace and session are released. | `21600000` (6 hours) |

The same variables work without Docker: build with `npm ci && npm run build`,
then run `node apps/web/dist/index.js` under whatever supervisor you prefer.
Node.js >= 24 and `git` must be installed.

Under Compose, a variable reaches the control plane only if it is listed in
the `control-plane` service's `environment:` block — `docker-compose.yml` says
so where it forwards the optional knobs. The three conversation settings are
not forwarded there yet, so a Compose deployment that wants one adds the line
(`COORD_MAX_CONVERSATION_SESSIONS: ${COORD_MAX_CONVERSATION_SESSIONS:-}`, and
the same shape for the other two) beside the ones already there. Empty is each
one's own default, so an unset variable changes nothing.

## Account email confirmation

Self-service sign-up first validates the submitted fields, hashes the password,
and mails a six-digit code to the address. No user, organization, membership,
project, or session is created at that point. The account is created and the
browser is signed in only after the code is submitted to
`/api/v1/auth/register/confirm` before it expires. A code is single-use and is
closed after repeated incorrect attempts. Pending challenges are process-local,
so a restart invalidates them and multi-instance deployments must route both
steps to the same control-plane instance.

Configure `COORD_SMTP_URL` for every shared deployment. Without it, the code is
written to the control plane log with the `[mail]` prefix and never reaches the
person's inbox.

## Forgotten passwords

Sign-in links to **Forgotten your password?**, which asks for an address and —
if that address has an account — mails a single-use link to it. The link is
`/#reset/<token>`: the secret sits in the URL fragment, which browsers never
send to a server, so it stays out of access logs. It expires after
`COORD_PASSWORD_RESET_TTL_MINUTES`, is invalidated by any later request for
one, and setting a password through it signs every other session for that
account out.

With no `COORD_SMTP_URL` set the request still succeeds and the message is
written to the log, prefixed `[mail]`. That is the whole recovery path for a
deployment with no relay: read the log, copy the link. Configure a relay for
anything other people use.

The request endpoint answers the same way whether or not the address has an
account, so it cannot be used to find out who is registered here. It shares
the sign-in rate limiter, which is what stops it being used to make this
deployment mail somebody repeatedly.

## Audit retention

The audit log is append-only and grows without bound, and every metrics pass
reads it. Compaction is explicit rather than automatic, because deciding how
much history to keep is an operator's call:

```bash
coord audit archive --before=2026-01-01T00:00:00.000Z
```

That moves every event before the cut into an archive table and records a
checkpoint holding the chain hash at the boundary plus a digest of the
segment. `coord verify-audit` still covers the whole history afterwards — it
walks the archived segments first and continues the live chain from the last
checkpoint. Archiving a chain that does not currently verify is refused, so a
checkpoint can never launder an existing break.

Export before reclaiming space, because pruning is not reversible:

```bash
coord audit export > audit-archive.jsonl
coord audit prune --through=100000
```

Pruning drops whole checkpointed segments. Verification keeps passing and
reports them as attested rather than retained: the checkpoint still proves the
segment existed and where it ended, but its contents are gone. `coord audit
checkpoints` lists what has been archived so far.

Deleting audit rows outside this path is refused by the database itself, in
both SQLite and Postgres — the delete trigger requires a checkpoint that covers
the row.

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
| `COORD_ORGANIZATION` | Organization the worker joins, and the only one it leases from. | required |
| `COORD_PROJECT_ROOT` | Directory with the worker's `.coordinator/config.json` (agents, sandbox). | working directory |
| `COORD_WORKER_ROOT` | Where leased workspaces are materialized. | `.coordinator/worker` |
| `COORD_WORKER_NAME` | Display name in the workers list. | hostname-derived |
| `COORD_PROJECT_ID` | Only lease work for this project. | `project_local` |
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
    "requireRemotePlanReview": false,
    "riskLevels": ["high", "critical"],
    "protectedPaths": ["secrets/**", "infrastructure/production/**"],
    "approvalTimeoutMs": 86400000
  },
  "budgets": {
    "maxTaskRuntimeMs": 1800000,
    "maxProjectRuntimeMsPerDay": 28800000,
    "maxTaskTokens": 2000000,
    "maxProjectTokensPerDay": 50000000
  }
}
```

- `approvals` controls when a changeset needs a human: always, by risk
  level, or when protected paths are touched. `protectedPaths` *replaces*
  the default protected set when present.
- `requireRemotePlanReview` moves the gate for remote work forward to plan
  admission, so a risky plan stops a worker before its agent runs rather than
  after. The reasons are the same ones the local scheduler stops on. It is off
  by default because it costs a second blocking gate per task and holds a
  repository concurrency slot while a person is asked.
- `budgets` are cost controls for remote execution, in two currencies. A task
  past `maxTaskRuntimeMs` or `maxTaskTokens` is failed at its next heartbeat —
  while it is still spending, which is the only moment stopping it saves
  anything. A project past its rolling 24-hour `maxProjectRuntimeMsPerDay` or
  `maxProjectTokensPerDay` stops receiving workers; queued tasks wait rather
  than fail. Budgets are throttles, not hard accounting: two workers leasing at
  the same instant can overshoot by at most one task.
- Token budgets only see spend an agent actually reports. The Codex adapter
  parses the figure its CLI prints and a generic-CLI agent may attach one to
  its `done` message; an agent that reports nothing cannot be capped this way,
  and is recorded as having reported nothing rather than as having spent zero.

## Production notes

- The control-plane image contains no Docker CLI, so the containerized
  control plane cannot run sandboxed tasks itself (`/api/v1/health` reports
  `docker.available: false`). That is the intended shape: task execution
  belongs on workers, which honor the project's container sandbox on their
  own machines.

- Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of
  port 4317, and set `COORD_TRUSTED_PROXY_HOPS` to the number of proxies in
  front of it — usually `1`. The control plane itself speaks plain HTTP, so
  without that count it cannot tell one client from the whole internet and
  cannot tell that the browser reached it over HTTPS. `COORD_SECURE_COOKIES=true`
  then only forces what the forwarded protocol already establishes.
- Keep deployment secrets in the `.env` file beside `docker-compose.yml`. It is
  git-ignored; a `.env` already committed to a clone of this repository stays
  committed, and its secrets need rotating rather than just deleting.
- Back up both the Postgres database **and** the `coordinator-data` volume;
  the store holds coordination history while the volume holds the canonical
  Git mirrors. They must be backed up and restored together.
- The coordination-store schema migrates itself on startup; run one control
  plane instance at a time (migrations are advisory-locked, but the process
  itself is not yet HA).
- `COORD_TEST_POSTGRES_URL` and `COORD_SKIP_POSTGRES_TESTS` affect only the
  test suite, never a running deployment.
