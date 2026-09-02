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
| `COORD_CREDENTIAL_STAGING` | Writable directory where per-task vendor credential homes are created. Codex refuses to create PATH-alias helper binaries when `CODEX_HOME` sits under `/tmp`, so the control-plane image points this at `/var/cache/coord/credentials`. Unset uses the process temp directory. | process temp directory (`/var/cache/coord/credentials` in the control-plane image) |
| `COORD_CREDENTIAL_POLICY` | What a task does when its submitter has connected no provider account: `refuse` fails the task, `host-login` falls back to the machine's own CLI login. `refuse` is the default because the fallback is silent — one person's task spends the host owner's subscription and nothing in the run says so. **A single-operator deployment where nobody has connected a provider account needs `host-login`, or its tasks stop running.** See [per-user provider accounts](architecture/per-user-credentials.md). | `refuse` |
| `KUMI_PAYMENTS_ENABLED` | Set to `1` to switch the payment pathway on. Off by default, and off means off: no checkout, no billing portal, no Stripe webhook, no trial, and no entitlement gate — every organization keeps full use of its repositories. Public sign-up becomes a waitlist at `POST /api/v1/waitlist`; whoever runs the deployment lets people through one at a time in Settings — Deployment, which admits that address at `POST /api/v1/auth/register` and gives it a free organization. The four `STRIPE_*` settings are only read when this is on. | off |
| `COORD_ALLOW_REGISTRATION` | Set to `0` to close self-service sign-up at `/api/v1/auth/register`. A new account owns its own organization and can run tasks, so close registration on a deployment strangers can reach unless that is intentional. Invitations are unaffected. `COORD_DISABLE_REGISTRATION=1` still closes it explicitly. | open |
| `COORD_REQUIRE_EMAIL_CONFIRMATION` | Set to `1` to make sign-up mail a six-digit code and create the account only once that code is submitted. Off by default: sign-up creates the account immediately and signs the browser in, so a deployment with no mail configured can still take sign-ups. Only turn it on where a mail transport below is configured and tested — otherwise the code goes to the log and nobody can finish signing up. | off |
| `COORD_MAIL_API_URL` | HTTPS endpoint of a mail provider used to send "forgotten password" links (and sign-up confirmation codes where `COORD_REQUIRE_EMAIL_CONFIRMATION` is on), e.g. `https://api.resend.com/emails`. Takes precedence over `COORD_SMTP_URL`. Prefer it on any platform that blocks outbound SMTP ports (Railway, Fly, most serverless hosts), where a relay cannot be reached and the code silently never arrives. The request body is `{from, to, subject, text}`, which every hosted provider of this shape accepts. Step by step: [setting up email](email-setup.md). | unset |
| `COORD_MAIL_API_KEY` | Bearer token for that endpoint. | unset |
| `COORD_SMTP_URL` | Relay used to send "forgotten password" links (and sign-up confirmation codes where `COORD_REQUIRE_EMAIL_CONFIRMATION` is on): `smtp://user:password@host:587` (STARTTLS when the relay offers it) or `smtps://host:465` (TLS from the first byte). Percent-encode an `@` in the password. Unset means messages are written to the control plane's log instead, which is a usable path for a single-operator deployment and no answer at all for a shared one. | unset |
| `COORD_MAIL_FROM` | `From` address on those messages, display name allowed (`Kumi <no-reply@example.com>`). Unset means `no-reply@<SMTP host>`, which most relays refuse to send as — set the address the relay has authorised. | `no-reply@<SMTP host>` |
| `COORD_PUBLIC_URL` | Absolute origin this deployment is reached at, used to build the reset link. Unset falls back to the `Host` header of the request that asked for the link — correct behind a router that sets it, wrong wherever a client can choose it. | inferred from `Host` |
| `COORD_PASSWORD_RESET_TTL_MINUTES` | How long a reset link stays usable. Requesting a new link always invalidates the previous one, whatever this is. | `60` |
| `COORD_TRUSTED_PROXY_HOPS` | How many proxies sit in front of this control plane. `0` ignores `X-Forwarded-For` and treats the socket peer as the client. Behind a platform router that means every request shares one rate-limit bucket, so one client can exhaust the ten-per-minute sign-in budget for everybody — set this to the real number of hops. Setting it higher than the truth lets a client choose its own bucket, so it is never inferred. Also what makes `X-Forwarded-Proto` trusted for the Secure-cookie and HSTS decisions. | `0` |
| `COORD_HSTS` | `Strict-Transport-Security` lifetime in seconds, sent only on requests that arrived over TLS. Empty means one year; `0` turns it off. Browsers remember it for the domain, so turn it off before ever serving that domain over plain HTTP. | one year |
| `COORD_SANDBOX_USER` | `UID:GID` the Docker sandbox runs containers as, when the project config names no `sandbox.user`. Empty means the user the control plane itself runs as — which owns the worktree being bind-mounted, so files the agent writes stay writable. Set it only for an image whose entrypoint needs root. | this process's UID:GID |
| `COORD_GITHUB_CLIENT_ID` | Client ID of a GitHub OAuth App with **Enable Device Flow** ticked (github.com → Settings → Developer settings → OAuth Apps). Turns on "Sign in with GitHub" when connecting the push credential in Settings; the device grant needs no client secret. Unset, connecting GitHub means pasting a personal access token. See [per-user provider accounts](architecture/per-user-credentials.md). | unset |
| `COORD_REPOSITORY_PARALLELISM` | How many remote workers may hold leases in one repository at once. Concurrent workers are separated at plan time: each submits its plan before editing and a colliding plan is sequenced rather than executed. Correctness does not depend on this setting — every result still integrates from its exact leased base or is requeued to replan — so raising it trades a little planning overhead for throughput. | `4` |
| `COORD_AUDIT_RETENTION_DAYS` | How long the live audit log keeps an event before it is compacted away. The log is the one table that grows with every task and never shrank: measured, a task writes about twenty-one events, so a deployment running ten thousand tasks a day writes six million rows a month. A sweep every six hours archives everything older than this window and prunes what it archived — the checkpoint survives, so the chain still verifies end to end; what is lost is the ability to read back what a sealed segment said. Set `0` to keep everything, which is what a deployment under a legal hold wants. An unreadable value falls back to the default rather than switching the sweep off, because a typo must not silently restore the unbounded growth this ends. | `30` |
| `COORD_LOCAL_AGENTS_ONLY` | Set to `1` — exactly `1`, and nothing else, so a fleet is never stopped by a value that merely looks affirmative — to stop this deployment spending agents on its own behalf. Three things honour it. **The queue:** a task whose owner has no machine listening is filed and waits rather than running here, and the thread says so instead of claiming to be working. **The turns nobody asked for:** the opening intent line on every dispatch, the classifier that reads every unaddressed channel message, the auditor on every canonical promotion, and the investigator on every failure are all skipped. **Questions:** an `@mention` that reads as a question is filed as a question and answered on its owner's machine, and only if that machine is listening — with the flag off, or with no live worker for that owner, it is answered here exactly as before. The failure mode to know: a question asked while the owner's machine is offline is answered here rather than routed, so turning this on does not by itself stop question spend for owners who have not installed the app. An unclaimed task has no expiry — it waits indefinitely and runs when its owner's worker next registers. | off |
| `COORD_DESKTOP_APP_ONLY` | Set to `1` to send desktop browsers asking for the dashboard to `/download` instead. A signpost rather than a control: the only thing separating the app from a browser on the same machine is a marker the app adds to its own User-Agent, which anybody can copy out of an install and paste into a browser. Phones and tablets are never redirected — there is no mobile build to send them to — and `/download` is an exact asset, so it stays reachable either way. Do not let anything security-shaped depend on it; `COORD_LOCAL_AGENTS_ONLY` is what actually refuses to execute. | off |
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

## Payments and the waitlist

**Off by default.** With `KUMI_PAYMENTS_ENABLED` unset, this deployment sells
nothing and gates nothing:

- `POST /api/v1/auth/signup` — the card path — answers `501`, and both the app
  and the marketing site point at the waitlist instead.
- `POST /api/v1/organizations/{id}/billing/checkout`, `.../billing/portal` and
  `POST /api/v1/stripe/webhook` answer `501`. Stripe is never called, and the
  client is not even constructed.
- No trial runs, and no organization is folded to read-only for lack of a
  subscription. Every organization created while payments are off is written
  as `comped`.

Anybody can ask for a place at `POST /api/v1/waitlist` (an address, optionally
a name and a note — nothing that can be signed in to). Whoever runs the
deployment sees the queue in **Settings — Deployment** and lets people through
one at a time; approving mails that address a link and admits it — and only it
— at `POST /api/v1/auth/register`, which builds them their own organization,
project and comped subscription. Every other way in is unchanged: an
invitation still works, and a comped invitation or repository grant still
carries no charge.

Switching `KUMI_PAYMENTS_ENABLED=1` back on restores the paid sign-up, the
fourteen-day trial and the entitlement gate exactly as they were; the waitlist
table and its routes stay, and `POST /api/v1/auth/register` goes back to `410`.

## Account email confirmation

**Off by default.** Self-service sign-up validates the submitted fields, hashes
the password, creates the account with its own organization and project, signs
the browser in, and lands the person in the app. Nothing is emailed, so a
deployment with no mail transport configured can still take sign-ups. The
address is taken on trust; anyone who can reach an open deployment can create
an account under an address that is not theirs, which is one more reason to
close registration (`COORD_ALLOW_REGISTRATION=0`) on a deployment strangers can
reach.

Set `COORD_REQUIRE_EMAIL_CONFIRMATION=1` to turn the mailed-code step back on.
Sign-up then mails a six-digit code and creates no user, organization,
membership, project, or session until that code is submitted to
`/api/v1/auth/register/confirm` before it expires; `POST /api/v1/auth/register`
answers `202` with the challenge instead of `201` with a session. A code is
single-use and is closed after repeated incorrect attempts. Pending challenges
are process-local, so a restart invalidates them and multi-instance deployments
must route both steps to the same control-plane instance. While confirmation is
off, `/api/v1/auth/register/confirm` answers `409
registration_confirmation_disabled`.

**Turning it on needs mail first.** [Setting up email](email-setup.md) is the
checklist: pick a transport, verify a sender address, set the variables,
confirm a code arrives. Configure `COORD_MAIL_API_URL` (with
`COORD_MAIL_API_KEY`) or `COORD_SMTP_URL`, and set `COORD_MAIL_FROM` to an
address the provider has verified. With neither transport set, the code is
written to the control plane log with the `[mail]` prefix and never reaches the
person's inbox — the control plane warns about that once at boot, the sign-up
screen says the code went to the log rather than telling anybody to check their
email, and `POST /api/v1/auth/register` answers `"delivery": "log"` instead of
`"mailbox"`.

On a platform that blocks outbound SMTP — Railway among them — an SMTP relay
connection times out and every sign-up with confirmation on fails at the "could
not be delivered" step. Use the HTTPS mail API there. Under Compose, these
variables reach the container only because they are listed in the
`control-plane` service's `environment:` block; a deployment that adds another
one has to add the line too.

## Forgotten passwords

Sign-in links to **Forgotten your password?**, which asks for an address and —
if that address has an account — mails a single-use link to it. The link is
`/#reset/<token>`: the secret sits in the URL fragment, which browsers never
send to a server, so it stays out of access logs. It expires after
`COORD_PASSWORD_RESET_TTL_MINUTES`, is invalidated by any later request for
one, and setting a password through it signs every other session for that
account out.

With neither `COORD_MAIL_API_URL` nor `COORD_SMTP_URL` set the request still
succeeds and the message is written to the log, prefixed `[mail]`. That is the whole recovery path for a
deployment with no relay: read the log, copy the link. Configure a relay for
anything other people use — see [setting up email](email-setup.md).

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
| `COORD_WORKER_CONCURRENCY` | How many tasks this machine runs at once. | sized from memory, at least 4 |
| `COORD_PROJECT_ID` | Only lease work for this project. | `project_local` |
| `COORD_REPOSITORY` | Only lease work for this repository. | any |

A worker holds several leases at once and runs their agents together, the way
a control-plane run leases a whole wave rather than one task. The default is
the same memory-derived figure `COORD_REPOSITORY_PARALLELISM` uses, so a
machine offers what it can hold; `COORD_WORKER_CONCURRENCY=1` makes it take
one task at a time. The repository's own parallelism bound still applies on
top and is the one that governs: a worker that asks for more than a repository
admits is simply not granted the extra leases.

This matters most with `COORD_LOCAL_AGENTS_ONLY=1`, where the control plane
executes nothing and every task waits for somebody's machine. A fleet of
one-task workers there is a queue that runs one agent at a time no matter how
much work is submitted, which looks from the outside like a coordinator that
has stopped rather than a fleet that is full.

A worker that shuts down cleanly releases its leases immediately; one that
dies simply stops heartbeating and the leases expire, so its tasks return to
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
