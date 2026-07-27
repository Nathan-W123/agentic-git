# Docker Sandbox

`DockerWorkspaceManager` keeps the git worktree on the host and runs only the
agent's command inside a container. See the Security Boundary section of
[the Phase 0 architecture](../../docs/architecture/phase-0.md) for what that
does and does not isolate.

## Build the reference image

```powershell
docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
```

The image contains `reference-agent.mjs`, a dependency-free implementation of
[the generic CLI protocol](../../docs/protocol/generic-cli.md) that performs the
benchmark's cap task. It exists to verify the sandbox, not to be a real agent.

## Verify

```powershell
npm.cmd run verify:docker
```

This exercises the real `DockerWorkspaceManager` code path and checks what only
a live daemon can answer:

- the daemon accepts the confinement flags,
- the workspace bind mount is readable and writable, and host and container see
  the same bytes,
- `--network none` denies DNS resolution,
- the worktree's `.git` pointer is masked,
- the container root filesystem is read-only,
- a full coordinated run integrates with the agent inside a container.

**Status: not yet executed.** No Docker daemon was available on the machine
where this was written, so every check above is unverified against a real
runtime. The argument construction and delegation behavior are covered by unit
tests in `services/workspace-manager`, which need no daemon.

## Running the benchmark sandboxed

```powershell
$env:COORD_AGENT_CMD = "node"
$env:COORD_AGENT_ARGS = '["/opt/agent/reference-agent.mjs"]'
$env:COORD_AGENT_SANDBOX = "docker"
$env:COORD_AGENT_IMAGE = "coord/reference-agent:1"
npm.cmd run benchmark -- --live --scenario=overlap
```

`COORD_AGENT_CMD` and `COORD_AGENT_ARGS` name a path **inside the container**.

## Known constraints

**The worktree `.git` pointer does not survive the mount.** A detached git
worktree stores a `.git` *file* holding an absolute host path to the canonical
repository, for example:

```text
gitdir: C:/Users/you/AppData/Local/Temp/coord-.../canonical.git/worktrees/task_cap-...
```

That path does not exist in the container, so git commands inside the sandbox
cannot work and the file leaks the host directory layout. The manager therefore
mounts an empty tmpfs over `<workspace>/.git` by default, which turns the
failure into a plain "not a git repository" and reveals nothing. Agents do not
need repository metadata: the coordinator collects the diff on the host after
the agent signals completion. Set `maskGitMetadata: false` to opt out.

**File ownership on Linux.** The bind-mounted worktree is owned by the host
user. If the container uid cannot write it, the agent fails on its first edit.
Set `COORD_AGENT_USER` to a matching uid, for example `COORD_AGENT_USER=1000:1000`.
Docker Desktop on macOS and Windows remaps ownership and does not need this.

**Validation still runs on the host.** Only the agent command is containerized.
Integration compiles, tests, and promotes in a host worktree, so validation
commands are as trusted as the repository they come from.
