# AI-Native Development Coordinator

A multi-developer, agent-neutral coordination platform that safely schedules,
isolates, validates, and integrates work from humans and coding agents against
one continuously managed canonical codebase.

The product is not another coding agent. It is the coordination layer between
developers, coding agents, workspaces, the shared codebase, test and build
systems, Git, and security policy. Agents plan before editing, work in isolated
overlays, negotiate scope, replan when canonical changes, and submit changes
through validation, approval, and atomic promotion.

The intended deployment model is multi-developer and multi-device: developers
and agents connect from different machines, over a LAN, from managed cloud, or
from a customer-hosted or on-premises environment. See
[instructions.md](instructions.md) for the authoritative scope, phases, and
architecture rules.

**Where does repository code live?** Today, Lattice keeps its copy of the
repository on the machine where Lattice is running—not automatically in the
cloud. Agents work on temporary copies, and GitHub is updated only when someone
explicitly exports the repository.

**Current deployment status.** One active control-plane process owns canonical
Git repositories and integration. Remote workers can execute on other machines
over HTTP, and coordination state can live in PostgreSQL for shared access.
High availability, shared canonical object storage, and the broader hosted
deployment stack are not built. The
[current capability matrix](docs/architecture/current-state.md) records the
exact implemented and later-phase boundary.

## Implemented

- Generic JSONL, Codex, Claude, and Gemini adapters with plan, execute,
  cancel, scope-change, and replan behavior; the generic protocol also
  supports pause and resume.
- Greenfield project start, local Git import, and credential-safe GitHub
  import over HTTPS or SSH.
- One-way export back to GitHub on a dedicated branch, refused when upstream
  moved since import.
- Isolated Git worktrees and an optional deny-by-default Docker execution
  boundary.
- File, symbol, dependency, API, schema, configuration, test, service, and
  advisory intent conflict evidence.
- Configurable conflict scoring, ownership leases, dependency-aware waves,
  failure propagation, and atomic compare-and-swap integration.
- Canonical-change indexing, durable plan revisions, live scope negotiation,
  and agent replanning against fresh canonical worktrees.
- Conversational tasks: replying in a thread continues the same task with the
  same agent, keeping its workspace and session between turns and catching
  that workspace up to whatever else landed meanwhile. Every turn still plans,
  validates, and promotes like an ordinary task, and the held sessions are
  bounded by a configurable cap and idle timeout.
- SQLite and PostgreSQL task queues, tenant/project isolation, approvals, full
  changesets, integration history, audit compaction, and hash-chain
  verification across archived and live events.
- A versioned HTTP API with sessions, CSRF protection, RBAC, rate limiting,
  security headers, and project-scoped WebSocket events.
- A responsive control room for setup, tasks, board, runs, diffs, replans,
  approvals, review comments, repository history, pipeline-safe rollback,
  workers, teams, project settings, and system administration.
- Per-user browser overlay workspaces with Monaco editing, bounded
  Docker-sandbox commands, and submission through ordinary admission,
  approval, validation, and compare-and-swap promotion.
- Deterministic coordinated-versus-uncoordinated benchmarks.

## Version-Control Surfaces

Every promotion creates a Git commit. Canonical history browsing,
pipeline-safe rollback to a previous version, review comment threads on diffs,
and task-board views are implemented in the API and control room. Rollback is
submitted, conflict-checked, validated, policy-gated, and promoted like any
other change; it is never a raw reset.

By design, there is no direct branch/merge/reset access to the canonical
repository outside the coordinator's pipeline, in any phase. An
uncoordinated write path would reintroduce the races the platform exists to
prevent. Read-only Git access and export are guaranteed instead.

## Requirements

- Node.js 24 or newer
- Git 2.40 or newer
- Docker only when running untrusted agents through the container sandbox

Git worktrees isolate repository changes but not the host process. Use the
Docker backend before running an agent you do not trust.

## Build And Verify

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run check
npm.cmd run benchmark
```

Docker runtime verification is separate, and covers both execution paths:

```powershell
docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
npm.cmd run verify:docker
npm.cmd run verify:remote-docker
```

`verify:docker` covers the local path: one process owning canonical, creating
worktrees, and running an agent in a container. `verify:remote-docker` covers
hosted execution — a real control plane on a real port, a real worker daemon
leasing a task and running its agent in a container, and the changeset coming
back through admission, validation, and promotion. Both pass against a live
daemon; the confinement checks in the remote run are made from inside the
container by the agent itself and travel back with its changeset.

## Project CLI

Initialize a coordinator project in the repository or parent directory where
you want `.coordinator` state:

```powershell
node C:\path\to\coordinator\apps\cli\dist\index.js init
node C:\path\to\coordinator\apps\cli\dist\index.js repo create new-product
node C:\path\to\coordinator\apps\cli\dist\index.js repo add C:\path\to\repo --id=core
node C:\path\to\coordinator\apps\cli\dist\index.js task submit --objective="Implement the approved change"
node C:\path\to\coordinator\apps\cli\dist\index.js run
```

Operational commands include:

```powershell
node apps/cli/dist/index.js repo github owner/repository
node apps/cli/dist/index.js repo create new-product --branch=main
node apps/cli/dist/index.js repo push --branch=coord/release
node apps/cli/dist/index.js repo list
node apps/cli/dist/index.js task list
node apps/cli/dist/index.js task retry <task-id>
node apps/cli/dist/index.js task cancel <task-id>
node apps/cli/dist/index.js approval list
node apps/cli/dist/index.js approval show <approval-id>
node apps/cli/dist/index.js approval approve <approval-id> --actor=<user-id>
node apps/cli/dist/index.js approval reject <approval-id> --actor=<user-id>
node apps/cli/dist/index.js history
node apps/cli/dist/index.js verify-audit
node apps/cli/dist/index.js doctor
```

Configure agents and repository validation commands in
`.coordinator/config.json`. The default configuration is intentionally missing
an agent so a project cannot silently execute with an unintended provider. Its
portable validation baseline is `git diff --check`; replace or extend that
command with the repository's real test and build commands.

## Web Control Room

Start the web/API process against an initialized project:

```powershell
$env:COORD_PROJECT_ROOT = "C:\path\to\initialized-project"
$env:COORD_BOOTSTRAP_TOKEN = "use-a-long-one-time-secret"
npm.cmd run web
```

Open `http://127.0.0.1:4317`. The first-run form creates the initial owner and
local organization.

`COORD_BOOTSTRAP_TOKEN` is optional. Omit it and first-run setup is open: the
first account created becomes the owner, and the form does not ask for a
token. Set it and that same form requires it. Either way the door locks behind
the first person through — once any user exists, setup refuses outright.

Omitting it is reasonable when the URL is not public. **Set it for anything
reachable by people you have not chosen**, because whoever completes setup
becomes the system administrator.

The server binds to loopback by default. Relevant deployment variables are:

| Variable | Purpose |
| --- | --- |
| `COORD_PROJECT_ROOT` | Initialized coordinator project directory. |
| `COORD_HOST` | Listen address; defaults to `127.0.0.1`. |
| `COORD_PORT` | Listen port; defaults to `4317`. |
| `COORD_BOOTSTRAP_TOKEN` | First-owner setup secret. Optional; omit to leave setup open. |
| `COORD_ALLOWED_ORIGINS` | Comma-separated additional browser origins. |
| `COORD_SECURE_COOKIES` | Set `true` behind HTTPS. |

## Real Agents

The benchmark can replace selected scripted tasks with a real JSONL process:

```powershell
$env:COORD_AGENT_CMD = "node"
$env:COORD_AGENT_ARGS = '["./my-agent.mjs"]'
npm.cmd run benchmark -- --live
```

Add `COORD_AGENT_SANDBOX=docker` and
`COORD_AGENT_IMAGE=<image>` to confine that process. The native Codex project
adapter uses ephemeral `codex exec` processes with read-only planning and
workspace-write execution. On native Windows it explicitly selects Codex's
preferred `elevated` sandbox backend so scoped writes keep working even while
personal Codex configuration is ignored.

See the [generic agent protocol](docs/protocol/generic-cli.md), the
[coordination architecture](docs/architecture/coordination.md), the
[Docker boundary](infrastructure/docker/README.md), and the
[benchmark methodology](docs/benchmarks/README.md) for details.
