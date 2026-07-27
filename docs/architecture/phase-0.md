# Phase 0 Architecture

## Outcome

The Phase 0 prototype answers one question: can deterministic coordination
prevent avoidable rework when two agents plan to edit the same repository?

The implementation is deliberately local and dependency-light. It keeps the
canonical repository as a bare Git repository, gives each task a detached Git
worktree, validates patches in another temporary worktree, and promotes a
candidate commit by atomically updating the canonical branch reference.

## Dependency Direction

```text
apps/cli
  -> services/coordinator
      -> services/integration-service
          -> services/workspace-manager
              -> services/repository-service
      -> packages/agent-protocol
      -> packages/shared-types

adapters/*
  -> packages/agent-protocol
  -> packages/shared-types
  -> services/workspace-manager   (contracts only)
  -> services/repository-service  (contracts only)
```

Core services do not import provider adapters. Agent-specific behavior remains
at the edge of the system.

An adapter that drives a real process needs two contracts from the workspace
layer: `WorkspaceManager`, to turn a finished workspace into a changeset, and
`WorkspaceSandbox`, to confine the agent command. Both are interfaces, so no
adapter depends on a specific workspace backend.

## Canonical State

The canonical repository is bare and therefore has no writable working tree.
Every task workspace starts from an explicit canonical revision. A changeset
records both the monotonic canonical version and its Git revision.

Integration follows this transaction:

1. Read the current canonical revision.
2. Create a detached integration worktree at that revision.
3. Apply the task patch with Git's three-way support.
4. Run validation commands without a shell.
5. Commit the candidate in the detached worktree.
6. Update `refs/heads/main` only if it still equals the revision read in step 1.

The final update is a compare-and-swap. Concurrent canonical movement causes a
stale result rather than silently overwriting accepted work.

## Coordination

Conflict analysis is deterministic. Phase 0 scores file overlap only, using the
documented weight of 20 per overlapping file and capping the total at 100.
Exclusive file leases still sequence colliding tasks even when a low numeric
score would otherwise permit concurrent execution.

The scheduler greedily creates waves of non-overlapping plans. Tasks in a wave
can execute concurrently; integration remains ordered and atomic. A task
blocked by file ownership starts its workspace from the newest canonical
revision after the preceding wave finishes.

Scoring only file overlap means dependency-level conflicts are invisible: a task
that changes a signature and a task that adds a caller in another file are
scheduled concurrently, and the second fails validation after applying cleanly.
The `dependency` benchmark scenario measures this miss rather than hiding it.
See [the benchmark notes](../benchmarks/README.md).

## Agent Process Boundary

`GenericCliAdapter` drives provider-neutral command-line agents over
newline-delimited JSON on stdin and stdout, spawned with argument arrays and
`shell: false`. Requests are strictly one reply each, with unsolicited `event`
lines allowed at any point, and every reply is validated before it reaches the
coordinator: plans go through `assertAgentPlan`, and the resulting changeset is
still checked against the approved scope. Requests time out, and a child that
exits or emits unparseable output fails the task rather than hanging it.

Changes are never reported by the agent. The adapter collects the diff from the
host-side worktree, so a compromised agent cannot fabricate a patch for a file
it did not touch.

See [the generic CLI protocol](../protocol/generic-cli.md) for message shapes.

## Security Boundary

Commands use argument arrays and `shell: false`. Repository paths and changed
paths are validated before integration. Git worktrees isolate filesystem
changes but do not isolate processes, credentials, network access, CPU, memory,
or the host filesystem.

`DockerWorkspaceManager` closes that gap for the agent process. Worktree
creation, diff collection, and canonical promotion stay on the host because the
compare-and-swap integration flow needs the canonical repository directly. Only
the agent's own command is confined:

- a container that bind-mounts the task worktree and nothing else,
- `--network none` by default, with an explicit network mode as the opt-out,
- memory, CPU, and PID limits,
- `--cap-drop ALL`, `--security-opt no-new-privileges`, and a read-only root
  filesystem with an explicit tmpfs list,
- no host environment variables; container environment must be declared.

Because a container cannot gain a bind mount after it starts, a sandboxed
session runs a planning container with no mount and then an execution container
with the workspace mounted. The adapter re-sends `start` and the approved plan
to the second process.

A detached worktree's `.git` is a file holding an absolute host path to the
canonical repository, which does not resolve inside the container and leaks the
host layout. The manager masks it with an empty tmpfs by default. Agents do not
need repository metadata: diffs are collected on the host after completion.

Validation commands are **not** containerized. Integration applies, tests, and
promotes in a host worktree, so a repository's own test commands run with host
privileges. Only the agent process is confined.

The Docker backend has not been executed against a live daemon. Argument
construction and delegation are unit tested without one; the runtime behavior is
covered by `npm run verify:docker`, which has not yet been run. See
[the sandbox notes](../../infrastructure/docker/README.md).

`GitWorktreeWorkspaceManager` remains the default and is suitable only for
deterministic local experiments with trusted behavior.

## Validation Integrity

`runProcess` strips `NODE_TEST_CONTEXT` from every child environment. Node's
test runner sets it in the processes it spawns, and a nested `node --test` that
inherits it reports over the parent's IPC channel and exits 0 regardless of its
own assertions. Since validation commands are commonly `node --test`, inheriting
it would silently disable the integration gate whenever the coordinator itself
ran under a test runner — promoting changesets that never passed. This is
covered by a regression test in `services/repository-service`.

The general rule: a process the coordinator spawns must not be able to mistake
itself for a child of the harness that started the coordinator.

## Deferred Work

- Durable database and append-only audit storage
- Human approval gate
- GitHub repository import
- Live event transport
- Symbol and dependency indexing
- Real Codex process driver
- Container image build and lifecycle management for sandboxed agents
- Container-side validation commands; integration still validates on the host
- Crash recovery and worktree garbage collection across coordinator restarts

