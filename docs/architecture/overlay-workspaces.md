# Overlay workspaces: the dashboard editor and terminal

The web dashboard's Explorer view gives a person the same thing an agent
gets: an isolated workspace based on canonical, plus a way to run commands
in it and a single, policed path for its edits to reach canonical. This
document records what the boundary is and why it is drawn where it is.

## What an overlay is

An overlay is a detached git worktree of one repository, created from the
canonical head, owned by exactly one user. It lives under
`.coordinator/overlays/<hash>` where the hash is derived from
`(userId, projectId, repositoryId)`. The location is deliberately outside
`workspaces/`, `planning/`, and `integration/`, which crash recovery clears
at boot — overlays survive restarts.

An `<hash>.json` sidecar records the owner triple and the canonical version
the overlay is based on. On every access the record is verified against the
authenticated principal; a mismatch is refused (`overlay_corrupt`), never
adopted.

## Ownership is by construction

Route handlers never accept a workspace identifier from the client. The
overlay directory is derived server-side from the *authenticated* user id,
so there is no request a user can craft that addresses another user's
overlay. Two users editing the same repository get two disjoint worktrees.

Authorization on top of ownership:

| Operation | Permission (role) |
| --- | --- |
| status / open / reset / discard / list / read / write / submit | `submit_task` (developer+) |
| exec (terminal) | `run_task` (developer+) |

Viewers and reviewers cannot open an overlay at all. Archived projects
refuse everything except `view` at the authorization layer.

## File access rules

- Paths are resolved against the overlay root and refused if they escape it
  (`..`, absolute paths, NUL bytes).
- Any path segment named `.git` is refused in both directions: reading it is
  useless, and writing it would repoint the worktree at an arbitrary
  repository.
- Reads are capped at 1 MiB and binary files are flagged rather than
  returned; writes are capped at 512 KiB. Larger changes belong to agents or
  local clones, not a browser editor.

## The terminal boundary

`POST …/workspace/exec` runs **one** `bash -lc <command>` per request inside
the same Docker confinement agents get (`DockerWorkspaceManager`):

- network `none` — verified: `connect` returns "Network is unreachable";
- `--cap-drop ALL`, `--security-opt no-new-privileges` — verified:
  `CapEff: 0000000000000000`;
- read-only root filesystem with a tmpfs `/tmp` — verified: writing to
  `/bin` fails;
- memory (2g), cpu (2), and pids (512) limits;
- only the overlay worktree is mounted, at `/workspace`, with an empty file
  bind-mounted read-only over its `.git` pointer so the container cannot see
  or rewrite git metadata (the canonical mirror is *not* reachable from
  inside the container);
- a 30 s wall-clock timeout and a 256 KiB output cap per stream;
- every execution is written to the audit log
  (`workspace_command_executed`, with actor, command prefix, and exit code).

If the project has no `sandbox` configured in `.coordinator/config.json`,
the endpoint answers 501 and the dashboard disables the terminal. There is
**no host-execution fallback**, by design.

Deliberate limitations (accepted trade-offs, not bugs): no PTY, so
interactive programs (vim, watch, REPLs) and job control don't work; state
(environment variables, background processes) does not persist between
commands because each command is a fresh container. What does persist is
the filesystem of the overlay, which is the part that matters for a
build/test/inspect loop.

## Canonical is never written directly

The editor and terminal only ever touch the overlay worktree. The single
way overlay edits reach canonical is `POST …/workspace/submit`, which is
modeled line-for-line on canonical rollback:

1. the overlay diff is collected as an ordinary changeset;
2. a plan for the touched files is admitted against the plans of currently
   executing work (a collision with an active lease blocks the submit);
3. the project's approval policy runs — protected paths, risk levels, or
   `requireChangesetReview` put a human gate in front of it;
4. the project's validation commands run in an integration worktree;
5. promotion is compare-and-swap on the base revision: if canonical moved
   since the overlay was opened, the submit fails as stale instead of
   overwriting newer work, and the user resets the overlay onto the new
   head.

On success the overlay is rebased onto the new canonical head; the run, the
changeset, validation results, and audit events are all recorded and visible
in the Runs view like any agent's work.
