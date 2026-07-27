# AI-Native Development Coordinator

This repository implements a local control plane for coordinating humans and
heterogeneous coding agents against a Git-backed canonical codebase. Agents
plan before editing, work in isolated overlays, negotiate scope, replan when
canonical changes, and submit changes through validation, approval, and atomic
promotion.

The current implementation includes the complete technical proof, the local
MVP product surfaces, deterministic structural coordination, and dynamic
replanning described in [INSTRUCTIONS.md](INSTRUCTIONS.md). See the
[current capability matrix](docs/architecture/current-state.md) for the exact
implemented and later-phase boundary.

## Implemented

- Generic JSONL and native Codex adapters with plan, execute, pause, resume,
  cancel, scope-change, and replan behavior.
- Local Git import and credential-safe GitHub import over HTTPS or SSH.
- Isolated Git worktrees and an optional deny-by-default Docker execution
  boundary.
- File, symbol, dependency, API, schema, configuration, test, service, and
  advisory intent conflict evidence.
- Configurable conflict scoring, ownership leases, dependency-aware waves,
  failure propagation, and atomic compare-and-swap integration.
- Canonical-change indexing, durable plan revisions, live scope negotiation,
  and agent replanning against fresh canonical worktrees.
- SQLite task queues, tenant/project isolation, approvals, full changesets,
  integration history, and append-only hash-chained audit.
- A versioned HTTP API with sessions, CSRF protection, RBAC, rate limiting,
  security headers, and project-scoped WebSocket events.
- A responsive control room for setup, tasks, runs, diffs, replans, approvals,
  repositories, teams, project settings, and system administration.
- Deterministic coordinated-versus-uncoordinated benchmarks.

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

Docker runtime verification is separate:

```powershell
npm.cmd run verify:docker
```

The Docker daemon was unavailable in the latest audit environment. Container
argument and policy behavior is unit tested, but the live runtime script must
also pass on a Docker-capable host before treating that boundary as deployed.

## Project CLI

Initialize a coordinator project in the repository or parent directory where
you want `.coordinator` state:

```powershell
node C:\path\to\coordinator\apps\cli\dist\index.js init
node C:\path\to\coordinator\apps\cli\dist\index.js repo add C:\path\to\repo --id=core
node C:\path\to\coordinator\apps\cli\dist\index.js task submit --objective="Implement the approved change"
node C:\path\to\coordinator\apps\cli\dist\index.js run
```

Operational commands include:

```powershell
node apps/cli/dist/index.js repo github owner/repository
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
an agent so a project cannot silently execute with an unintended provider.

## Web Control Room

Start the web/API process against an initialized project:

```powershell
$env:COORD_PROJECT_ROOT = "C:\path\to\initialized-project"
$env:COORD_BOOTSTRAP_TOKEN = "use-a-long-one-time-secret"
npm.cmd run web
```

Open `http://127.0.0.1:4317`. The first-run form creates the initial owner and
local organization. When `COORD_BOOTSTRAP_TOKEN` is omitted, the server
generates and prints one at startup.

The server binds to loopback by default. Relevant deployment variables are:

| Variable | Purpose |
| --- | --- |
| `COORD_PROJECT_ROOT` | Initialized coordinator project directory. |
| `COORD_HOST` | Listen address; defaults to `127.0.0.1`. |
| `COORD_PORT` | Listen port; defaults to `4317`. |
| `COORD_BOOTSTRAP_TOKEN` | First-owner setup secret. |
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
workspace-write execution.

See the [generic agent protocol](docs/protocol/generic-cli.md), the
[coordination architecture](docs/architecture/coordination.md), the
[Docker boundary](infrastructure/docker/README.md), and the
[benchmark methodology](docs/benchmarks/README.md) for details.
