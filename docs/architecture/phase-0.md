# Phase 0: Technical Proof

## Outcome

Phase 0 is complete. The repository proves that planned ownership and ordered
integration avoid rework when multiple agents target one canonical Git
repository. The deterministic `overlap` and `mixed` benchmarks compare the
same tasks with and without coordination.

The implementation has since advanced beyond file-only coordination. Current
structural analysis and replanning are described in
[coordination.md](coordination.md).

## Canonical State

The canonical repository is bare and has no writable working tree. Every task
workspace starts from an explicit revision. Integration:

1. Reads latest canonical.
2. Creates a detached temporary worktree.
3. Applies the structured patch with Git three-way support.
4. Runs validation commands without a shell.
5. Commits the candidate with hooks disabled.
6. Updates `refs/heads/main` only when it still equals the revision read in
   step 1.

The final compare-and-swap prevents concurrent canonical movement from
silently overwriting accepted work.

## Agent Boundary

The provider-neutral `GenericCliAdapter` drives newline-delimited JSON agents
over stdin/stdout. The native `CodexAdapter` drives ephemeral `codex exec`
processes with structured output. Planning is disposable and execution is tied
to the granted workspace. Replies are validated, output is bounded, requests
have deadlines, and cancellation terminates child processes.

The host collects the Git diff. Agents do not supply trusted patch content.

## Workspace Boundary

`GitWorktreeWorkspaceManager` is the default for trusted local experiments. It
isolates repository edits but not process, host filesystem, credentials,
network, CPU, or memory.

`DockerWorkspaceManager` confines agent and validation commands with:

- one task worktree bind mount,
- no network by default,
- memory, CPU, and PID limits,
- dropped Linux capabilities and `no-new-privileges`,
- a read-only root filesystem and explicit tmpfs mounts,
- no inherited host environment,
- masked worktree Git metadata.

Docker behavior and command construction are unit tested. The live
`npm run verify:docker` proof remains pending only because the latest audit host
does not provide a Docker daemon.

## Validation Integrity

Child processes strip `NODE_TEST_CONTEXT`. Without that protection, nested
`node --test` commands can report through the parent harness and mask a failing
validation run. Repository-service regression tests cover this boundary.

## Evolution

Durable state, approvals, product surfaces, structural coordination, and
dynamic replanning landed after the proof. See
[Phase 1](phase-1.md) and the
[current capability matrix](current-state.md).
