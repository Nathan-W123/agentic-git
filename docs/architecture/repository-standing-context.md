# Repository standing context

**Status: landed.** One curated note per repository, set by the people who
work there, handed to every task that plans there. Delivery is to the
planning round only, on every path; the section at the end says why and what
a second phase would add.

The goal is that a task does not rediscover the repository from nothing.
Every run starts with an empty context window, and the first ten minutes of
most of them are spent learning what the last agent already knew: which
validation command actually works here, what the directory layout means, the
trap everybody falls into once.

## What existed, and why it was not enough

Two things already reached a task as background before this landed, and both
are projected by the control plane rather than written by anybody:

- **Handoffs** (`services/coordinator/src/handoff.ts`), written at every task
  boundary from the run record — the integration result, the validation
  commands and their exit codes, the resources ownership withheld. The rule
  there is stated in its header: nothing is written from memory, and there is
  deliberately no free-text "what I was thinking" field, because a summary of
  a session launders guesses into fact.
- **Planning hints** — where the objective's words appear in the symbol
  index, and where the repository has been working lately.

Neither can say "run `npm run test:unit`, not `npm test`; the integration
suite needs a database". A handoff can record that `tests` failed; it cannot
record what to do about it. That knowledge lives in people's heads and in
vendor files — `CLAUDE.md`, `AGENTS.md` — which the control plane never
records, a `generic-cli` agent never reads, and nobody can audit.

## The record

One row per repository in `repository_contexts` (migration 67,
`repository-standing-context`, in both dialects):

| Column | Meaning |
| --- | --- |
| `content` | Markdown, at most `REPOSITORY_CONTEXT_MAX_CHARS` (8,000). `""` is a cleared note. |
| `updated_by`, `updated_at` | Who last saved it, and when. |
| `version` | Starts at 1 and rises by one per save, clears included. |

Its own table rather than columns on `repositories`, because `listRepositories`
is read on every rail load and already carries a picture, and because a
versioned, attributed note has facts of its own. Keyed by repository like
`auditor_cursors` and removed by the same cascade in `removeRepository`.

`saveRepositoryContext` takes an optional `expectedVersion` (0 for "there was
none"). When given, the save applies only if that version is still current and
answers `stale` otherwise — the check and the write happen under one lock on
both backends, so two editors cannot both be told they won. A clear keeps the
row: an editor holding version 3 must not be able to pin a write against a
note that was cleared and rewritten as a fresh version 1.

Every save is an audit event, `repository_context_changed`, carrying the
actor, the new version, whether it was a clear and how long it is.

## Why a human-written block is allowed in prior context

This is the one block of `priorContext` that a person authored, and it is a
deliberate departure from the evidence-only rule the handoffs keep — not a
loophole in it. What makes the two compatible is what the record carries: a
named person stands behind the note, it has a version, and every change is
audited. A wrong note is attributable and correctable in a way a summary is
not. The renderer says so in the block itself ("Written by the people who
work in this repository (version N, last updated by …)"), and frames it as
background to check against the workspace, not a second set of instructions.

Rejected alternatives, and why:

- `CLAUDE.md` / `AGENTS.md` in the workspace: vendor-specific, invisible to
  `generic-cli`, outside the record.
- Prepending to `task.objective`: the objective is shown everywhere, and an
  agent reads it as the thing to build.
- An automatic summary in the style of the channel memo: derived and
  unattributed — the opposite of a note somebody stands behind.

## Who may set it

The rename/picture gate: `manage_project` through the ordinary permission
pipeline, or the repository's creator (`authorizeRepositoryOwnerAction`). The
note is injected into every run in the room, which makes setting it repository
administration rather than a per-task steer. Reading is open to anyone who can
see the repository — there is nothing to gain by hiding from a developer what
their own tasks are being told.

The slash command makes that same call rather than restating it. It first
carried only the sender's user id and answered from the same two sources
(membership role, repository grant) plus `createdBy`, which folded the billing
entitlement and checked archival but could not see an API token's scopes — so
a token scoped to `view` set from the room what `PUT .../context` refuses it.
`dispatchChannelMentions` and `runSlashCommand` therefore carry the whole
`AuthenticatedPrincipal`, and `/context` calls
`authorizeRepositoryOwnerAction` directly. A channel test drives an admin, the
creator, a bystander and two of the owner's API tokens through both gates.

## The three ways to set it

- `PUT /projects/:p/repositories/:r/context { content, expectedVersion? }`,
  and `GET` on the same path. A stale pin is a 409 `stale_version`.
- `/context` in a channel: bare shows the rendered block, `/context <note>`
  sets it (interior line breaks kept), `/context clear` clears it. Answered in
  the room it was typed in, like `/help` — a channel message, in the
  repository's own room or a work sub-channel's, which is every room where a
  slash command is read as a command at all. A task thread is not one: its
  replies go to that thread's agent, and the thread reader answers only the
  thread-scoped commands, so `/context` typed there is read as a question,
  exactly as `/plan` or `/help` would be. The web picker still lists it in a
  thread, because its thread-first array is an ordering and not an allow-list,
  and was left alone.
- MCP: `get_repository_context` (scope `view`) and `set_repository_context`
  (scope `manage_project`, optional `expected_version`). Refusals are
  sentences the model can read out, because the person is in an editor and
  cannot go and look at a 403.

Every writer refuses over-cap content before storing it; the renderer
head-truncates as a defence against a row written past the limit by an older
writer. Head rather than tail, unlike `boundCommandOutput`: a failing command
says what went wrong at the end, a curated note puts what matters first.

## Where it goes in the prompt

One pure function, `renderRepositoryContext` in `@coord/shared-types`,
renders the block for every path. Shared-types rather than the coordinator
because the gateway — which briefs editors and answers the MCP read — does
not depend on `@coord/coordinator` and should not take on its build graph for
one function.

`priorContext` is assembled nearest-first, and the same rule places the note,
with one deliberate exception. In the coordinator (`coordinator.ts`, where it
builds `startInput`) the order is `[thread, turn-start note, lease note,
standing context, likely files, recent touch points, handoffs, derived
pitfalls]`. The thread, the turn-start note and the leases are about *this*
task. The standing context comes next, ahead of the file estimates and recent
touches even though it is about the repository in general: it is the one
block a person wrote and stands behind, where the estimates are the control
plane's guesses, and it is where the remote worker puts it too. The handoffs
follow as older per-task projections, with the derived tallies last because
they are the least specific.

The remote worker (`worker.ts`, after `claimRepository`) builds
`[thread, standing context, planning hints]` — the same order, minus the parts
a worker never has (a turn-start note, a lease note and handoffs are the
coordinator's). The worker has no file estimates of its own, so the note
sits where it does in the coordinator's list: had the coordinator put the
estimates first, the same task would get a differently ordered prompt
depending on where it ran. The note rides in `priorContext` only and never in
`task.context`, so no adapter ever presents it as something said in the
conversation.

The adapters' planning-prompt label changed with it. It used to say "Notes
left by earlier work in this repository", which became untrue the day a
human-written block arrived in the slot; it now names both provenances.
Generic wording rather than detecting the heading, because an adapter that
grepped `priorContext` for a heading would couple two packages on a string.

## The three delivery paths

1. **In process** — `standingContextForTask` in
   `services/coordinator/src/repository-context.ts`, read per planning round
   beside the handoffs, guarded so a task that cannot read the note still does
   the work. The guard does not answer `""`: that is what a repository whose
   people have written nothing renders, and a planning prompt with no standing
   block in it reads as a repository with no conventions to keep. A read that
   fails renders a block of its own saying so, under a third heading, because
   "we could not read it" is an unknown and must not pass for an answer.
2. **Remote worker** — `claimWorkRepository` in `apps/cli/src/worker-operations.ts`
   reads and renders it last, after every early return, and the claim route
   carries it as `standingContext` **whether or not a claim was granted**: the
   protocol's answer must not depend on the claim decision, so the field means
   the same thing on both branches and phase 2 can deliver it to execution
   without changing the wire. Today it is carried and not rendered on the
   claimed branch — a granted blanket claim builds no prompt at all, and the
   note is rendered only into the planning prompt (see "Known limit: planning
   only" below). Only `planningContext` is withheld on a claim. The claim
   route's contract is therefore `{ plan?, planningContext?, standingContext? } | 204`,
   and a 204 now means no plan and no context of any kind — a 200 without
   `plan` is not a claim. A lease whose base revision cannot be resolved still
   gets `{}`: the worker cannot run it either. No protocol version bump: the
   field is optional, old workers ignore it, old control planes omit it.
3. **Editor** — `take_task` fills `McpTakenTask.standingContext` from the
   store with the same renderer, and `takenTaskBrief` appends it after the
   validation commands, labelled as background. The editor is the third
   surface that executes a task and the only one with no adapter prompt to
   carry the note.

The benchmark's uncoordinated arm (`prepareUncoordinatedTask` in
`apps/cli/src/benchmark.ts`) passes no prior context and stays that way: it is
the baseline. The coordinated arm goes through `coordinator.ts` with a store
and inherits the note like any run.

## The derived pitfalls block

Beside the note, and in process only, the coordinator projects a second block
from the handoffs it already read: validation labels that failed in two or
more recorded handoffs, with counts —

    ## Derived from the coordination record

    Projected from validation results in recorded handoffs, not written by
    anyone; a label that keeps failing is usually an environment or setup
    pitfall worth stating in the standing context above.

    - `tests` failed in 3 of the last 12 tasks that ran it (most recently
      task_x, 2026-07-29)

Computed at read time by `derivePitfalls`, never persisted; a person promotes
a line by writing it into the standing context, which is the only way it
becomes something somebody stands behind. Its own top-level heading rather
than a sub-heading of the curated block, because the two have opposite
provenances and a reader must not be able to conflate them.

The date is the day of the most recent failure, taken from the handoff that
recorded it, because the block's claim is about what does not work here *now*:
three failures last week is a broken command and three from February is one
somebody fixed. A record that does not say when it was written is reported as
`date unknown` rather than dated from anything else.

A label is not prose anybody vouched for — the project config that supplies
one lives in the repository being worked on, and a plan's `commands` come from
the agent — so it is flattened to one line, its backticks neutralised and its
length bounded before it is quoted. Left verbatim, a label carrying a newline
and the curated block's own heading would forge, inside the block that says
nobody wrote it, the attribution the two headings exist to keep apart. The
block itself is capped at twenty lines and states how many it left out.

One audit read, deliberately. `findTaskHandoffs` reads the whole
type-filtered audit log whatever `limit` it is given (the filter has no
repository column), so the coordinator reads twenty-five handoffs once and
takes both the five-handoff seed and the tallies from that array. It is not
computed on the worker path: the claim route runs per lease and does no
handoff read today, and this feature does not introduce one there.

## Known limit: planning only, on every path

`priorContext` reaches the planning prompt and nothing else — the codex and
prompt-cli adapters render it there, and the execution, replan and
clarification rounds read `task.context`, which is the conversation alone.
So a standing note that says "run `npm run test:unit`" informs the plan, and
the execution turn has to have carried that forward itself. This is the same
limit every other block in `priorContext` has always had, applied
consistently rather than worked around: the worker test pins that the
execution prompt does not contain the note, so it cannot regress into the
transcript.

A second phase would add `StartTaskInput.standingContext` in
`packages/agent-protocol`, carried by the coordinator and the worker as the
curated block alone, appended by the prompt-cli and codex execution prompts
under wording of its own, and forwarded on the `generic-cli` `start` message.
It is not built, and the decision not to ride the note in `task.context` in
the meantime is deliberate — that slot is presented to the model as something
somebody said.

## Costs worth stating

- Up to 8,000 characters on every planning prompt in the repository, on top
  of five handoffs. Bounded, but a repository that fills the cap pays it on
  every task; "small" in the interface copy means small.
- A persistent text injected into every run in the repository is a prompt
  surface. The gate, the audit event with actor and version, and the
  "background, not a second set of instructions" framing are the mitigation;
  widening the gate to developers widens the surface.
