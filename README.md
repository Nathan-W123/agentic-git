# AI-Native Development Coordinator

This repository contains the Phase 0 technical proof for a coordination layer
that schedules heterogeneous coding agents against a Git-backed canonical
codebase.

The current prototype proves the smallest useful loop:

1. Two agents submit plans before editing.
2. The coordinator detects deterministic file overlap.
3. Tasks receive temporary file ownership.
4. Each task runs in an isolated Git worktree.
5. Changes are collected as structured changesets.
6. Validation runs in a temporary integration worktree.
7. A passing candidate is promoted with an atomic Git compare-and-swap.
8. A benchmark compares coordinated and uncoordinated execution.

## Requirements

- Node.js 22.18 or newer
- Git 2.40 or newer

Docker is optional. By default the proof uses Git worktrees for filesystem
isolation only. `DockerWorkspaceManager` adds process, network, CPU, and memory
isolation for the agent command and is required before running an untrusted
agent.

## Commands

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run demo
npm.cmd run benchmark
```

`demo` prints the coordination decisions and final canonical source.
`benchmark` runs a task set in coordinated and uncoordinated modes and reports
integration attempts, failures, and rework.

Three scenarios are available via `--scenario=<name>`:

| Scenario | Tasks | What it shows |
| --- | --- | --- |
| `overlap` | 2 | Ownership sequences a colliding task; 1 rework avoided. |
| `mixed` (default) | 5 | A three-way collision is ordered while independent tasks still run in parallel; 2 reworks avoided. |
| `dependency` | 2 | A cross-file dependency conflict that file-level detection provably misses. |

See [the benchmark notes](docs/benchmarks/README.md) for the measured numbers
and what each metric means.

## Running a real agent

Both commands accept `--live`, which replaces the scripted behavior for
selected tasks with a real process driven over newline-delimited JSON:

```powershell
$env:COORD_AGENT_CMD = "node"
$env:COORD_AGENT_ARGS = '["./my-agent.mjs"]'
npm.cmd run benchmark -- --live
```

Add `COORD_AGENT_SANDBOX=docker` and `COORD_AGENT_IMAGE=<image>` to run the
agent inside a container that mounts only its own workspace and has no network
access. Tasks not selected with `COORD_AGENT_TASKS` keep their deterministic
scripted behavior, which is the path CI uses.

The Docker backend's runtime behavior has not yet been exercised against a live
daemon; `npm.cmd run verify:docker` does that in one command. See
[the sandbox notes](infrastructure/docker/README.md).

See [the generic CLI protocol](docs/protocol/generic-cli.md) for the message
shapes an agent must implement, and
[the Phase 0 architecture](docs/architecture/phase-0.md) for component
boundaries, guarantees, and known limitations.

