# Deleting messages

## Why this needed deciding

"Delete message" is one label over at least four different behaviours, and the
products that have it do not agree. Before this existed, the only deletion in
the product was an admin clearing threads out of a channel — nothing a person
could do about their own words, and nothing at all in direct messages or the
private agent panel.

The question the design had to answer is the one in the title of every support
thread about this feature: *does deleting the message stop the work it asked
for?* In a chat app there is no work, so the question never comes up. In an
agent harness the message **is** the instruction, and a delete that leaves the
run going is a person withdrawing a request while a machine carries on acting
on it, with the surface they would have stopped it from now gone.

## What comparable systems do

Written from prior knowledge of these products rather than from testing them
during this change; treat the specifics as approximate and the pattern as the
point.

**Group chat (Slack, Discord, Teams).** Delete is a real, server-side delete,
gone for everyone. Authors delete their own; moderators delete anyone's. Slack
and Discord both keep a *thread* alive when its parent goes — Slack shows "This
message was deleted" and the replies stay reachable — because the replies are
other people's writing and belong to the room, not to whoever opened the
thread. Deletion is audited even when it is not shown. Nothing is stopped,
because nothing was running.

**Assistant chat (ChatGPT, Claude.ai).** There is no per-message delete at all.
There is *edit-and-resubmit*, which truncates the conversation from that point
and starts a new branch, and there is delete-the-whole-conversation. This is not
squeamishness: the transcript is replayed to the model on every turn, so a
history with a hole in it is a history the model never had — an answer to a
question that is no longer above it. Truncation is the only coherent
single-message operation on a replayed transcript.

**Agent harnesses (Cursor, Devin, Copilot Workspace, Claude Code).** These split
the two ideas apart. Stopping is its own control — a stop button, `Esc`, a
cancel — and it is never spelled "delete". Removing a message is either a
context operation (rewind/restart from here, dropping the provider-side session
with it) or a purely cosmetic clear of the transcript view. What none of them
do is silently stop a run because a message was tidied away, and none of them
delete a message and leave the run going *without saying so*.

**The pattern.** Deletion means different things to a room, to a transcript, and
to a run, and the products that feel right are the ones that pick the meaning
from what the message actually is rather than applying one rule everywhere. So
does this.

## What this platform does

Three chat surfaces, three rules, one principle: *deleting a message removes
everything the message itself is, and nothing that belongs to somebody else.*

### 1. The repository channel

`DELETE /api/projects/:p/repositories/:r/channel/messages/:id`

- **Who.** The author, or anyone with `manage_project`. "The author" includes
  the messages of your own agent — an agent posts on its owner's credential
  under a name that owner chose, and the room holds that person responsible for
  the line. Never anybody else's agent. System lines are the coordinator's and
  are nobody's to unsay.
- **What.** A message nobody has replied under is removed outright. A message
  that carries a thread is **blanked in place** — content emptied, reactions
  and any pin dropped, `deleted_at`/`deleted_by` stamped — and the replies
  stay. This is Slack's rule and it is here for Slack's reason: the replies are
  the agent's account of a task and the record of what was changed, read by
  other people, and taking them with the request would be deleting somebody
  else's reading. Reactions and pins go because both were attention paid to a
  line that no longer exists; a banner pointing at a tombstone is worse than no
  banner.
- **The run.** If the message's task is still live, deleting the message
  **stops it**, through the same cancel path the dashboard's stop button uses
  (`operations.cancelTasks`, falling back to a store-only row flip on
  deployments that cannot reach a live run). A task that has already reported —
  `integrated`, `failed`, `cancelled`, or an `open` conversational turn that has
  landed — is left alone; deleting an old thread is housekeeping, not a recall.
  The confirmation dialog says the run will be stopped *before* the delete, and
  the response reports whether it actually was, so the toast can say so. If the
  stop fails the message still goes: the person asked for the words to be gone,
  and the run keeps its own stop button.
- **Replies** (`.../messages/:id/replies/:replyId`) go outright. A reply is a
  leaf, so there is nothing a tombstone would be protecting.
- **`?purge=1`** takes the whole thread, replies included, and needs
  `manage_project` however the message got there. This is what the thread
  panel's own delete has always meant and what its confirmation still promises
  — "everything in it goes" — so it kept its behaviour rather than quietly
  becoming a tombstone. Unsaying one message is the button on the message.
- Clearing the whole channel is unchanged: `manage_project`, everything goes,
  no cancellation sweep.

### 2. Direct messages

`DELETE /api/projects/:p/direct-messages/:otherId/messages/:id`

Sender only, gone for both sides, no tombstone. The two people in the
conversation are its whole audience, so there is no third party whose reading a
tombstone would be preserving — and "delete for me" would be a filter on one
screen while the sentence stayed on the other, which is not what unsending
means to anybody. The store enforces the sender rule in the same statement that
removes the row, so there is no window between checking and deleting.

This one is **not audited**, and that is deliberate rather than an omission:
the audit chain is replayed to every subscriber of the project, and "A deleted
a message to B" is the shape of a private conversation even with the words left
out. Sending a direct message already avoids the chain for the same reason. The
other side learns of it through a `direct-message-deleted` socket frame
addressed to the two of them (`sendToUsers`), which is what takes the sentence
off the recipient's screen without a reload.

### 3. The private agent panel

Client-side, because that is where this transcript lives: it is held in the
browser and replayed to the provider on every turn. Deleting a message **rewinds
the conversation to just before it**, taking everything after it too, for the
assistant-chat reason above — a hole in a replayed history is a history the
model never had.

It also **drops `cliSessionId`**. A CLI-backed agent keeps its own copy of the
conversation behind that id, and resuming it after a local truncation would have
the agent still remembering, word for word, what the reader believes they
deleted. Losing a warm session costs latency; keeping it costs the meaning of
the button.

## What was deliberately not built

- **Undo / a trash window.** Every delete here is confirmed and immediate. A
  restore path means keeping the row, which means keeping the words, which is
  the thing being asked for the removal of.
- **Editing.** A different feature with a different audit story.
- **Tombstones for replies and direct messages.** Both are leaves with no third
  party to keep a record for.
- **Cancelling on a channel-wide clear.** Sweeping a room should not stop work
  in a repository as a side effect.

## Audit

Nothing in the *channel* is deleted quietly. `channel_message_deleted` carries
the message id, the author, the actor, whether it was redacted rather than
removed, and the task id and whether it was cancelled; `channel_reply_deleted`
is the same shape for a reply. A stopped task also appends its own
`task_cancelled` with `reason: "message_deleted"`, so the two records join up.

Both event types begin `channel_` and carry `repositoryId`, which is what makes
other viewers converge for free: `app.js`'s socket router already reconciles the
open channel against the store on any `channel_*` audit frame. Direct messages
have their own private frame instead, for the reason above.

## Where it lives

| Piece | File |
| --- | --- |
| Store contract, `redactChannelMessage` / `deleteChannelReply` / `deleteDirectMessage` | `services/persistence/src/store.ts` |
| Tombstone columns (migration 33) | `services/persistence/src/schema.ts`, `postgres-schema.ts` |
| Routes, authorization, run cancellation | `services/api-gateway/src/server.ts` |
| Client calls and local state | `apps/web/public/data.js` |
| Channel and DM affordances, tombstone rendering | `apps/web/public/screen-chats.js` |
| Private-panel rewind | `apps/web/public/chat.js` |
