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

**Liveness has three answers, not two.** An editor is live in the sense the
roster cares about, so it is folded into the one liveness answer this process
gives. But a worker and an editor are not the same promise: a worker polls, so
a task it can take starts within seconds, while an editor cannot be woken and
picks work up the next time somebody asks it to. Anything that tells a room
work has *begun* asks which it is talking to. A mention addressed to an agent
that is only present in an editor is acknowledged with "I'll pick it up the
next time I'm asked there" rather than "I'm working on it", which would be a
lie for as long as nobody asks.

That distinction has one sharp edge worth knowing about: an editor's `workers`
row looks exactly like a desktop's, because it is one. It carries
`EDITOR_WORKER_VERSION` so the two can be told apart, and the constant is
shared rather than written twice — the first draft of this compared literals
in two packages and the distinction quietly collapsed.

**The worker row exists for the foreign key.** `work_leases.worker_id`
references `workers(id)`, so a lease needs a row. One row per person per
editor, reused across every task that editor does, and retired by the ordinary
sweep once it has been idle and holds nothing.

## Who does the work when nobody was named

`submit_task` used to *require* an agent name. That looked like a small piece
of strictness and was in fact a decision made in the wrong place: a person who
names nobody has expressed no preference, so the model — forced to fill the
field in — picked one off the roster. Work typed into Codex was run by Claude,
and nothing anywhere had chosen that on purpose.

The name is optional now, and the connection answers instead. Kumi knows which
editor holds the token: it is recorded on the token at mint (migration 57),
with the token's name as the fallback for connections made before that column
existed. So, in the order a person means them:

1. **They named an agent** — that one, always.
2. **They named nobody and the caller is a known editor** — that person's own
   agent for that editor. A prompt typed in Codex is Codex's work.
3. **They named nobody and the room has exactly one agent** — that one. Not a
   guess.
4. **Anything else** — the roster comes back with "who should do this?" and
   nothing is filed until somebody answers.

When the answer is (2), the task is filed *and taken back in the same call*:
the channel message is posted first, so the room sees the work and the thread
follows it exactly as before, and then the lease goes to the editor that asked
rather than to whatever polls first. The reply is the same brief `take_task`
gives, so the turn continues straight into doing the work.

Two details that fall out of this:

- An editor's own agent is never sent down the offline exchange. Presence is
  only declared once an editor takes work, so on the first prompt of a session
  it reads offline — and telling somebody their machine is not listening while
  they are typing into it is nonsense.
- If something else wins the race to the lease, that is not an error. The task
  is real and filed; the answer says where it went.

`take_task` reads the editor the same way, so its `editor` argument is now a
correction rather than a requirement.

The rule that falls out of all of this, stated once: **work goes to whatever
is actually present and able to start it now.** A prompt typed in an editor is
that editor's, because the person is sitting in front of it. A mention typed
in Kumi goes to the desktop, because the desktop is the thing that polls and
nothing is watching an editor. Only when neither is there does a task wait,
and then the room is told so.

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

## The project's tools, in the editor

The same connection carries traffic the other way. A project admin approves an
MCP server once; every agent Kumi starts on a teammate's laptop gets it. The
person in Cursor got nothing, and would have had to add the same server to
their own config with their own copy of the API key.

An approved server can therefore be re-offered through the endpoint the editor
is already connected to. Its tools appear as `<server>__<tool>`, and a call is
relayed to the far end with the project's own secrets attached. The editor
never sees the key.

Three limits, all deliberate:

- **HTTP servers only.** A `stdio` server is a process, and the control plane
  starting a process chosen by a project admin is the one thing this
  architecture has consistently refused. Those keep running where they already
  do: on the machine that consented, beside an agent, under a lease. Trying to
  open one to editors is refused with a sentence saying why.
- **A second opt-in per server**, `editorEnabled`, and it can only be granted
  while the ordinary approval is in force. `enabled` means the server may run
  on a teammate's laptop after that machine agrees; this means the control
  plane itself dials it, with the project's secrets, for whoever is typing.
  Different blast radius, different switch. Withdrawing the approval takes
  editor access with it, so there is no state where a withdrawal leaves a
  server reachable.
- **`COORD_MCP_ENABLED` is a fence, not a suggestion.** With it off nothing is
  dialled, whatever is stored.

`tools/list` runs at the start of every editor session, so the manifest is
cached for five minutes, keyed on the server row's `updatedAt` — every write
moves it, so an edit or a withdrawal invalidates itself with no cache-busting
call for a route to forget. Concurrent handshakes share one dial. A failure is
cached for a minute, so one server being down does not spend every handshake's
patience, and does not keep it invisible once it returns. One unreachable
server never costs the others their tools.

Every proxied call is audited as `mcp_tool_called`, so "was Linear reachable
during that afternoon" is answerable afterwards.

## Where the code is

| Concern | File |
| --- | --- |
| The three tools, and the diff parser | `services/api-gateway/src/mcp-work.ts` |
| Presence and bundle tickets | `services/api-gateway/src/editor-sessions.ts` |
| Taking, extending, admitting, reporting | `apps/cli/src/editor-work.ts` |
| The manifest cache and the tool proxy | `services/api-gateway/src/mcp-proxy.ts` |
| The outbound dial, with its five guards | `services/api-gateway/src/mcp-dialer.ts` |
| The bundle route and the liveness merge | `services/api-gateway/src/server.ts` |
