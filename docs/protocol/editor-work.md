# Doing Kumi's Work From an Editor

[Remote workers](remote-workers.md) describe one way a Kumi task gets done: a
process on somebody's machine leases it, materialises a workspace, runs a
vendor CLI, and returns a changeset. This document describes the other way.

Somebody is already in Claude Code, Cursor or Codex, with the repository open,
paying for an agent that is perfectly capable of doing the task itself. What
they lack is everything Kumi holds: which task is next, what revision to start
from, permission to touch those files while other agents touch others, and
somewhere for the result to land. Three MCP tools hand them exactly that, and
nothing else.

```
take_task  ->  (the agent works in its own checkout)  ->  report_task
                              |
                              +-- extend_task, when a turn runs long
```

No Kumi CLI is installed, no worker process runs, and nothing executes on the
control plane. `COORD_LOCAL_AGENTS_ONLY=1` is unaffected: execution was always
somebody else's machine, and this is one more kind of somebody else's machine.

## What is different from a worker, and why

**The lease is taken, but the plan is not admitted with it.** A worker
declares its scope before it moves and is arbitrated against that declaration.
An editor has already moved by the time Kumi hears from it, so the honest
claim is the set of files its diff actually touched. That claim is strictly
narrower than anything it could have promised in advance, and it is decidable
at the moment it is made rather than guessed half an hour earlier. Admitting a
blanket claim at take time would hold the repository for the whole window with
a scope nobody could narrow, because there is no holder process to ask.

So `take_task` leases (which is what stops a desktop worker grabbing the same
objective) and `report_task` admits. Admission runs through the ordinary
`admitWorkPlan`, so an editor that wandered into a file another agent holds
gets the same answer a worker would, including a partial admission that defers
the contested files.

**The window is thirty minutes, not five.** A worker's lease is renewed by a
timer beside the process, so a short TTL only ever asks "is that process
alive". An editor's is renewed by an agent choosing to call a tool, and
between two such calls a person can read a diff, go and look at something, and
come back. `extend_task` pushes the hold out, capped at an hour per request.

**Presence is declared, not inferred.** An editor cannot be woken: nothing
polls on its behalf. Liveness for editors is therefore an in-memory window
opened by `take_task` and refreshed by `extend_task`, merged *inside* the
gateway's single liveness answer rather than consulted beside it. A second
source read by the roster and not by dispatch is how an agent comes to be
drawn as available and then told nothing is running it.

Losing that window to a restart is not a fault; presence lapses, which is what
presence does. The first mention after a restart may say "nothing is running
it yet" and the task simply waits in the queue until the editor asks for it.

**The worker row exists for the foreign key.** `work_leases.worker_id`
references `workers(id)`, so a lease needs a row. One row per person per
editor, reused across every task that editor does, and retired by the ordinary
sweep once it has been idle and holds nothing.

## The base revision, and the bundle

Kumi's canonical branch diverges from `origin/main` the moment anything
integrates without being pushed, so "work from the revision you have" is not
safe advice. `take_task` names the exact revision to start from and gives a
one-shot link to a bundle carrying it:

```
curl -fsSL "<link>" -o /tmp/kumi-<task>.bundle
git fetch /tmp/kumi-<task>.bundle
```

A bundle is a file rather than a Git server, which is why it is downloaded and
then fetched from disk. `extend_task` issues a fresh link, because a ticket
lives ten minutes against a hold that runs for thirty.

The link is a ticket in the path, not a token in a header, because the caller
is a `curl` with nowhere to put one. It names one lease, is spent on first
use, and expires on its own. `GET /api/v1/mcp/bundle/:ticket` is therefore on
the public path list in the sense of "no cookie and no bearer"; the lease is
re-checked behind the ticket, so a hold that has since been settled is refused
with 409 rather than served.

## Authorization

All three tools ask for `submit_task`, never `run_task`.

That is deliberate and it is the same reasoning `cancel_task` follows.
`run_task` is the scope `POST /workers/leases` requires, so a token handed to
an editor to do one task would otherwise be able to register as a worker and
lease everybody else's. Instead:

- the token carries `submit_task`,
- `authorizeProject` is checked on the task's own project,
- the hold's worker row must belong to the caller, and
- `claimableBy` clamps a take to the caller's own queued work, because an
  editor offers exactly one person's vendor login.

A repository grant narrows a take the same way it narrows a worker's lease: a
collaborator invited to one repository is handed work from that repository and
no other.

## Reporting

`report_task` takes the output of `git diff <base revision>` verbatim. It is
split per file by reading the lines that are unambiguous — `rename to`, then
`+++ b/`, then `--- a/` — rather than the `diff --git a/X b/Y` header, which
cannot be parsed at all when a path contains a space (git does not quote them,
so `a/src/a b/c.ts b/src/new.ts` splits at either ` b/` with equal
justification). A rename claims both the name it took and the name it left, so
it cannot move a file out from under an agent holding it under the old one.

Three endings:

| `status`   | What it means                        | What happens to the task |
| ---------- | ------------------------------------ | ------------------------ |
| `done`     | Here is the diff                     | Admitted, integrated, thread updated |
| `failed`   | I tried and could not                | Failed, with the reason in the thread |
| `released` | I have not started; somebody else should | Back in the queue |

`failed` skips admission entirely: work that did not land has no scope to
arbitrate, and refusing it for missing paperwork would turn "I could not do
this" into "the control plane rejected your report".

A hold that lapses *during* integration is reported as a lost hold rather than
a refusal, with the advice to take the task again and report the same diff.
The window really can close inside the call.

## Where the code is

| Concern | File |
| --- | --- |
| The three tools, and the diff parser | `services/api-gateway/src/mcp-work.ts` |
| Presence and bundle tickets | `services/api-gateway/src/editor-sessions.ts` |
| Taking, extending, admitting, reporting | `apps/cli/src/editor-work.ts` |
| The bundle route and the liveness merge | `services/api-gateway/src/server.ts` |
