# Conversational tasks

A design for replying to a task and having the same agent continue, instead of
starting a new one that remembers nothing.

Built, in the four stages below. Written after a session in which the
difference between commissioning work and having a conversation turned out to
be the largest remaining gap between what an agent can do and what a person
working alongside one can. The document is kept as written — a design, in the
present tense, describing the thing that now exists — because what it argues
about *why* each half was chosen is still the reason the code is shaped this
way. Where it says "has to change", the change has been made.

## What is actually missing

Less than it looks, and more than a feature.

An agent already receives the thread it was asked in — `TaskDefinition.context`
carries the conversation, and handoffs (`seedContextForTask`) carry what earlier
tasks learned. So an agent is not working blind. What it cannot do is
*continue*: every reply is a new task, with a new plan, a new workspace, and no
memory of the last one beyond what was written down.

Three things end a task today, and each has to change:

- **The workspace is destroyed.** `cleanupTask` (`coordinator.ts:2538`) calls
  `workspaces.destroy` when the task settles.
- **The session is closed.** The adapter cancels it, and with it goes whatever
  the underlying CLI was holding in context — which is the expensive half.
- **There is no status for "open".** `SubmittedTaskStatus` is `submitted`,
  `claimed`, `integrated`, `failed`, `cancelled`. Every one of the last three is
  terminal.

And a fourth thing does not exist at all: **a reply dispatches nothing.** The
replies route (`server.ts`, `channel/messages/:id/replies`) appends a reply and
returns. Only the room's own `messages` route dispatches mentions. So there is
no reply→agent path to reroute; there is one to build.

## The decision that shapes everything

**Each turn lands.** Reply → the agent works → change set collected → validated
→ integrated → canonical advances. Exactly as a task does now.

What persists between turns is not uncommitted code. It is the agent's session,
and the workspace *directory* — so `node_modules`, build output and scratch
files survive, which also makes each turn faster.

The alternative — hold everything uncommitted until the conversation ends — is
worse in three ways, and they are not close:

- The **lease** would be held for the whole conversation, blocking every other
  agent from those files while a person thinks about their next message.
- A crash, or a closed tab, **loses everything**.
- Exact-base integration protects work at the moment it lands. A conversation's
  worth of unlanded changes is a conversation's worth of unprotected work.

Landing per turn keeps every safety property the system already has. It is also
what makes the feature explicable: a conversational task is a series of ordinary
tasks that happen to share a workspace and a memory.

## The hard part

After a turn lands, canonical has moved — by that turn's own commit — and the
workspace has to catch up. For its own commit that is trivial.

**If another agent landed something meanwhile, the workspace has to be rebased
onto it before the next turn starts.** That is the whole difficulty of this
feature, and it is not new machinery: `assessReplay`, `CanonicalAdvance` and the
replan path already answer "canonical moved, is this work still applicable". What
changes is *when* they run — at the start of a turn, rather than only at
integration.

Three outcomes, all of which the existing code already distinguishes:

- the advance is disjoint from this conversation's work → fast-forward the
  workspace and carry on;
- it overlaps but merges cleanly → merge, tell the agent what moved underneath
  it, carry on;
- it conflicts → the turn opens by telling the agent what changed and asking it
  to work from the new state, which is the same conversation a replan already
  has with an agent.

Get this wrong and the second turn of every conversation is wrong. It deserves
to be built and tested before anything user-visible exists.

## The shape

### Status

One new status: `open`. A task that has completed a turn and is waiting for the
next message. Not terminal, and distinct from `claimed` — which means a runner
holds it *right now*.

A task ends when somebody ends it: an explicit "that's it", a period of silence,
or the ordinary case of nobody replying, which the existing lease expiry already
models. Whatever ends it, the terminal statuses stay exactly as they are.

### Lease

Released at the end of each turn, taken again at the start of the next.

Holding one across a conversation would make a person's thinking time into other
agents' waiting time. Releasing it means the next turn is arbitrated afresh —
which is correct: between turns, somebody else may legitimately have taken those
files, and the plan for turn three has to be admitted against the world as it is
rather than as it was.

### Session

Kept open between turns, and closed when the task ends.

This is the part that makes it a conversation rather than a sequence, and it is
the part with a cost: a held session is a held CLI process, and a deployment
with twenty open conversations is holding twenty of them. A cap, and an idle
timeout that closes the session while leaving the task `open`, are both
required — a conversation whose session lapsed can still continue, it just
starts the next turn cold with the thread as context, which is exactly what
happens today.

### Dispatch

The replies route learns to dispatch, on the same rule the room's messages route
already uses (`readsAsTaskRequest`) plus one more: a reply in a thread whose task
is `open` continues that task, whoever it mentions.

## Staging

All four are built; each landed in the order below, for the reasons below.

1. **Workspace and session survive a turn.** No user-visible change: a task
   completes, its workspace is kept, and a second turn is driven by a test
   rather than by a person. Everything else depends on this and nothing else
   can be tested without it. `ConversationRegistry` (`coordinator.ts`) is what
   holds them between turns, and its lifetime is why it is injectable: a
   coordinator is built per run, a conversation outlives one.
2. **Rebase at turn start**, with the three outcomes above, tested against a
   second agent landing between turns. The hard part, done second because stage
   one is what lets it be tested at all. See
   `services/coordinator/src/conversation.test.ts`, which drives a second agent
   into canonical between two turns for each of the three.
3. **The `open` status and lease handover**, still without a UI. The status is
   `SubmittedTaskStatus`'s one non-terminal ending; `expireOpenTasks` is how
   silence settles one.
4. **The replies route dispatches**, which is the point at which this becomes
   visible and, deliberately, the last thing built. The thread root is the
   conversation id, so every turn typed into one thread continues one task.

### What an operator sets

The two process bounds and the silence deadline are deployment knobs rather
than constants, because what they cost is machine-shaped and no default fits
every machine: `COORD_MAX_CONVERSATION_SESSIONS` (default 8),
`COORD_CONVERSATION_SESSION_IDLE_MS` (default fifteen minutes), and
`COORD_OPEN_CONVERSATION_MAX_AGE_MS` (default six hours). The first two shed
sessions only — the conversation stays open and continues cold — while the
third ends the waiting itself. A value that is not a whole number is refused
rather than ignored: a cap silently not the one you configured is worse than no
cap you chose. See [deployment](../deployment.md).

## What this is not

- **Not a long-lived agent.** The agent runs during a turn and is idle between
  them, exactly as now. What survives is context, not a process doing anything.
- **Not unlanded work.** Every turn integrates. A conversation is not a branch.
- **Not a replacement for handoffs.** Those carry knowledge *between* tasks and
  still should; this carries it *within* one.
- **Not a way around arbitration.** Each turn is admitted like any other task.
  A conversation gets no standing claim on the files it touched last turn.

## The cost worth naming up front

A held session is a held process, and this is the first feature in the system
that keeps one alive across the gap between a person's messages. Everything else
here is bounded by work; this is bounded by attention, which is far less
predictable.

That is the reason for the cap, the idle timeout, and for the session being the
*expendable* half of what persists: the workspace is cheap to keep and expensive
to rebuild, the session is the reverse. When something has to give, the session
goes first and the conversation survives it.
