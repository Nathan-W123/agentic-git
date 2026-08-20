# UI friction fix plan

The remediation half of [`ui-friction-audit.md`](ui-friction-audit.md). The
audit says what costs a person something; this says what to write, in what
order, and what has to be decided by a human before a line of it can be
written. Every finding in the audit appears here exactly once, including the
ones whose answer is "not yet, and here is the blocker".

Two rules shape it. **Anchors are symbols, not line numbers** — the audit's
line references have already drifted a little against the current tree, so
everything below names the function, the `case`, or the state key, which
survives the next edit. **Every batch lands alone** — no item waits on an item
in a later batch, and no batch leaves the product in a half-state if the next
one never ships.

## Re-checked against the tree as it stands

Before planning anything, the load-bearing claims were read again. All of them
hold:

- `ROUTES` in `app.js` really does carry `notifications` and `agents`, and
  `screen()` dispatches both — the screens are live, only unreachable.
- The `user-menu` case offers exactly `Settings`, a separator and `Sign out`.
- `unreadCount()` and `markRead()` exist in `data.js`; `markRead` writes
  `ag.read` truncated to the last 400 ids, and `notifications()` slices its
  rows from `state.audit` to 60.
- `loadChannel` calls `channelPath(repositoryId, "/messages")` with no query
  string, while the GET handler in `server.ts` reads `limit` (1–200, default
  50) and `before` from the query and passes both to
  `listChannelMessages`, whose memory-store implementation honours the cursor
  against `bumpedAt ?? createdAt`.
- `sendChannelMessage` sets `message.failed`, `postChannelReply` sets
  `reply.failed`, and no renderer in `screen-chats.js` reads either.
- The reaction affordances are drawn without an `isReply` guard, three lines
  below the pin button whose comment explains why pin has one.
- The changed-files disclosure is a bare `<details class="cmsg-changes">`,
  while the two other disclosures in the transcript persist through
  `state.thinkingOpen` and `state.summaryOpen`.
- The slash picker ends in `matching.slice(0, 6)` against a ten-command table.
- `state.changeSet` is a single global, written by `ensureCodeData` from the
  first run it finds for the repository, and read by the channel file panel and
  by the agent detail's Files tab alike.
- `chanToolsOpen` is `false` in the initial state with no `localStorage` read.

One correction and one find worth having:

- **The audit under-reports finding 1 by a hair.** There is already a
  `case "go-notifications"` in the action handler calling
  `navigate("notifications")`, and nothing in any screen emits that action. The
  route, the screen, the badge count and the handler all exist; the missing
  piece is a single button. That makes finding 1 the cheapest item in the whole
  audit, not merely a cheap one.
- **Finding 14 has a usable key already.** Every `ChangeSet` carries `taskId`,
  and `/runs/{id}` returns a run's `changeSets` alongside its `tasks`. Scoping
  a diff to the work in front of the reader is therefore a client-side cache
  keyed by `taskId`, not a schema change — see batch 6.

## How this is ordered

The audit's own "suggested order" sorts by cost. This sorts by *shared code
path*, because five of the cheap items touch the same three functions and
landing them together is one review instead of five conflicting ones. Cost is
still respected: batches 1 through 5 are all client-only.

| Batch | Findings | Shape | Depends on |
| --- | --- | --- | --- |
| 1 — Ways back in | 1, 2, 3 | Client only | — |
| 2 — Tell the truth about writes | 7, 8 | Client only | — |
| 3 — State that survives a render | 9, 16, 10 | Client only | — |
| 4 — Commands, and stopping work | 11, 12, 13 | Client only | decisions D1, D2 |
| 5 — The transcript window | 5, 6 | Client only, structural | batch 3 (scroll capture) |
| 6 — Scoping the changeset | 14, 15 | Client only, needs a fetch per task | batch 1 |
| 7 — Direct messages | 17, 18 | Client only | batch 1 |
| 8 — Keyboard | 22 | Client only | batch 1 |
| 9 — Settings and account | 19, 21, 20 | 19/21 client, 20 needs the server | decisions D3, D4 |
| 10 — Durable notification state | 4 | Needs a route | batch 1 |

## Decisions needed before batches 4 and 9

These are the four places where guessing wrong means writing the code twice.
Each has a recommendation; taking the recommendation is the default if nobody
says otherwise.

- **D1 — where the stop control lives (finding 12).** Either (a) in the thread
  panel header beside pin/continue-here, acting on that thread's task, or (b)
  on the channel message row for a running task, beside the existing revert
  button. *Recommended: (a).* The thread is where somebody watches a run and
  decides it has gone wrong, and the header already owns that thread's task.
- **D2 — what the Repository card in Settings should say (finding 13).**
  Either (a) rewrite the copy to point at `/push` in the channel and drop the
  CLI line, or (b) put a real Publish button on the card wired to the same path
  `/push` uses. *Recommended: (a) now, (b) later.* The card currently states
  the opposite of what the product does, and that is a copy bug worth fixing in
  the same hour it is noticed; a button is a new write surface with its own
  confirmation and permission questions.
- **D3 — merging the two Settings agent cards (finding 19).** Either (a) one
  card per provider showing both the deployment connection and your own
  credential, or (b) keep two cards and retitle them so the distinction is
  legible ("Available on this deployment" / "Connected as you").
  *Recommended: (a).* Two cards a screen apart managing the same providers is
  the friction; renaming them documents it rather than removing it.
- **D4 — non-image attachments (finding 21).** Either (a) client-only: keep the
  image allowlist but name every file that was skipped and why, or (b) widen
  the server allowlist to `text/plain` with the same leading-bytes discipline
  the image types get. *Recommended: (a) in batch 9, (b) as its own piece of
  work.* (b) crosses the security boundary that `attachments.ts` deliberately
  keeps short, and that deserves its own review rather than a line in a UI
  batch.

---

## Batch 1 — Ways back in

Findings 1, 2 and 3. The whole batch is one button, two menu entries and one
handler that navigates instead of stopping.

### 1 — Notifications has no entry point

**Now.** The route, the screen, the filters, `unreadCount()` and a
`go-notifications` action all exist. Nothing emits the action.

**Fix.** In the chat shell header (the `<span class="spacer">` /
`data-act="user-menu"` block in `app.js`), add an icon button before the
avatar: `data-act="go-notifications"`, bell icon, with a count badge rendered
only when `unreadCount() > 0`. Add `Notifications` to the `user-menu` list
above `Settings` as the keyboard-and-menu route to the same place. The badge
makes the comment above `agentNameForTask` — "which the bell badge asks for on
every render" — true again rather than archaeological.

**Touches.** `app.js` (header render, `user-menu` case), `styles.css` (badge),
`ui.js` only if the bell icon is not already in the icon table.

**Done when.** A signed-in user with an unread failure sees a count in the
header from any screen, and clicking it lands on `#notifications`.

### 2 — My Agents is reachable only when you have none

**Now.** The single `nav → agents` is the "Connect an agent first" menu item,
offered only when `myAgents().filter(connected)` is empty.

**Fix.** Add `My agents` to the `user-menu` unconditionally, above
`Settings`. Leave the "Connect an agent first" item exactly as it is — it is
a good empty-state affordance, it is just not a navigation strategy. This also
restores the only route to Add Agent, so connecting a second vendor stops being
impossible.

**Touches.** `app.js` (`user-menu` case).

**Done when.** With one provider connected, My Agents is two clicks from the
channel.

### 3 — A notification goes nowhere

**Now.** `case "notif-open"` calls `readOne(value, render)` and returns. Rows
carry `taskId`; nothing uses it.

**Fix.** Three steps.

1. In `notifications()`, carry `repositoryId` on each row alongside `taskId`,
   taken from the same `state.tasks` lookup that already resolves the task.
2. In `case "notif-open"`, after `readOne`, resolve a destination: if the row
   has a repository, `navigate("chats")`, select that channel, then look for
   the channel message whose `taskId` matches — the `chan-revert-task` button
   proves roots carry `taskId` — and set `state.activeChannelThread` to it.
   Fall back to selecting the channel with no thread when no message matches
   (the root may have aged out of the loaded window until batch 5 lands), and
   fall back to doing nothing but marking read when there is no repository.
3. Keep the row's read-marking unconditional, so a notification that cannot be
   opened still stops nagging.

**Touches.** `data.js` (`notifications()`), `app.js` (`notif-open` case).

**Done when.** Clicking "Task failed" opens the channel and the thread the
failure happened in.

**Test.** New `apps/web/src/navigation-entry-points.test.ts`, in the
source-shape style of `messaging-qol.test.ts`: assert the header emits
`go-notifications`, that `user-menu` lists both `notifications` and `agents`,
and that the `notif-open` case reaches `activeChannelThread`.

---

## Batch 2 — Tell the truth about writes

Findings 7 and 8: two places where the interface reports success it does not
have.

### 7 — A failed message looks sent

**Now.** `message.failed = true` / `reply.failed = true` are written and never
read. The toast is the only evidence and it clears itself.

**Fix.** Render the flag. In the message row builder in `screen-chats.js`, when
`entry.failed === true`, mark the row (a `cmsg-failed` class: muted body, red
"Not sent" label) and offer a resend action, `chan-message-resend`, carrying
the message id. The handler re-POSTs the same content through the existing
path; on success it clears `failed` and adopts the server id, on failure it
leaves the row as it is with a fresh toast. Do the same for the thread reply
row, which has its own renderer and its own `failed` flag.

Note the second half of the finding honestly: the local row still vanishes on
reload, because a failed post was never persisted anywhere. A durable outbox is
out of scope here; what this fix buys is that the failure is visible and
recoverable for as long as the tab lives, which is the window in which somebody
would actually retype the message.

**Touches.** `screen-chats.js` (message row, reply row), `app.js` (resend
case), `data.js` (a `resendChannelMessage` helper beside `sendChannelMessage`),
`styles.css`.

### 8 — Reacting to a reply cannot work

**Now.** The reaction tally and the hover React button are drawn on every
non-deleted row. Reactions live on `channel_messages`;
`toggleChannelReaction` throws for anything else, the route 404s, and the
optimistic emoji stays on screen until the next load.

**Fix.** Carry pin's rule across, which is what the audit asks for: guard both
reaction affordances with the same `isReply || inlineReply` test the pin button
uses, and move the explanatory comment so it covers pin *and* reactions rather
than pin alone. Also make `toggleChannelReaction` in `data.js` roll its
optimistic tally back when the POST rejects, so the same class of bug cannot
reappear from another entry point.

The alternative — reply reactions server-side — is a real feature with a
schema, a route and a payload shape, and it is not this. Record it as wanted;
ship the parity fix now.

**Touches.** `screen-chats.js` (row builder), `data.js`
(`toggleChannelReaction` rollback).

**Test.** Extend `messaging-qol.test.ts`, which already pins the reaction
picker: assert the reaction markup sits behind the reply guard, and that the
rollback exists.

---

## Batch 3 — State that survives a render

Findings 9, 16 and 10: three things the interface forgets, all because
`render()` rebuilds the screen on every poll.

### 9 — "N files changed" collapses every 30 seconds

**Fix.** Give the disclosure the treatment the other two already have: a
`state.changesOpen` map keyed by message id in `data.js`, `open` on the
`<details>` when the entry is `true`, and a `toggle` action mirroring the
`thinkingOpen` case in `app.js` (which reads the element's own `open` state
rather than assuming it). Update the comment above the builder — "it remembers
nothing" stops being a virtue the moment the screen is rebuilt around it.

**Touches.** `data.js` (state key), `screen-chats.js` (builder), `app.js`
(toggle case).

**Optionally, and worth pricing separately (9b).** The same rebuild also drops
text selection anywhere in the transcript. The cheap mitigation is to skip
`render()` when a poll changed nothing observable — hash the ids and edit
stamps of the loaded messages, compare with the last render's, and return
early. That is a change to the render loop with its own failure mode (a missed
update looks like a hang), so it is a separate piece of work with its own test,
not a line in this batch.

### 16 — The channel tools re-hide on every load

**Fix.** Persist `chanToolsOpen` the way `agentView` is persisted: read
`ag.chantools` in the initial state, write it in the toggle case in `app.js`.
One line each side.

**Touches.** `data.js` (initial state), `app.js` (toggle case).

### 10 — A dismissed question leaves no trace

**Fix.** Keep the dismissal — "Not now" should stay possible — but stop it
being silent. Above the composer, when the *unfiltered* pending-question list
for this channel is non-empty and the visible one has been dismissed, draw a
chip: "An agent is waiting on an answer — Answer", whose action clears the
`state.questionDismissed[requestId]` entry and re-opens the prompt. The filter
at the `questionDismissed` read in `data.js` stays as it is; the chip reads the
list before that filter, so the two cannot disagree.

**Touches.** `data.js` (expose the pre-filter list), `screen-chats.js`
(composer chip), `app.js` (undismiss case), `styles.css`.

**Deliberately not in this batch.** A badge on the channel row in the sidebar
for a question outstanding in another room. It is the right idea and it needs
the pending list for channels that are not open, which is a data question, not
a rendering one.

---

## Batch 4 — Commands, and stopping work

Findings 11, 12, 13. Blocked on D1 and D2 above; the rest can be written now.

### 11 — Four commands never appear in the picker

**Now.** `matching.slice(0, 6)` against ten commands, so with an empty query
`retry`, `cancel`, `stop` and `help` are invisible — including in a thread,
where the reordering hides a different four.

**Fix.** Drop the cut to six and show every match, with the picker list scrolled
rather than truncated (a ten-row list is not a scale problem). If a cap is kept
for layout reasons, make `help` immune to it, because a command whose whole job
is to list the others cannot be one of the ones you have to already know.

**Touches.** `screen-chats.js` (candidate builder), `styles.css` (max height,
overflow).

**Test.** Assert the candidate builder has no fixed slice, or that `help`
survives it.

### 12 — Nothing clickable stops a running agent

**Fix (D1 recommendation).** Add a Cancel control to the thread panel header
for a thread whose task is running, calling the existing `cancelTask`. Guard
it: a confirm step, since it ends work that is mid-run and holding a workspace.
Separately, fix the two existing controls on My Agents — `task-cancel` fires
straight through with no confirmation, and Retry is offered on tasks in any
state. Gate Retry to terminal states and route both through the same confirm
helper.

**Touches.** `screen-chats.js` (thread header), `screen-agents.js` (task row
buttons), `app.js` (`task-cancel`, `task-retry` cases).

### 13 — Settings sends you to a terminal for something `/push` does

**Fix (D2 recommendation).** Rewrite the Repository card's copy: publishing
canonical to a remote branch is `/push` in the channel, and the platform push
action behind it. Keep a mention of the CLI as the equivalent outside the
product if that is still true, but stop asserting "there is no HTTP route for
it, so this is not a button" — the product has had one since
`push-canonical.ts` landed.

**Touches.** `app.js` (`settingsScreen`, Repository card).

---

## Batch 5 — The transcript window

Findings 5 and 6. Structural, still client-only, and the largest single gain in
the audit: the server route, the `before` cursor and both store implementations
are already there and waiting.

### 5 — Permanently capped at the newest 50 roots

**Fix.**

1. `loadChannel` passes an explicit `limit` (50 is the right first page) and
   records whether the page came back full, in `state.channelHasMore`.
2. Add `loadEarlierChannelMessages(repositoryId)` to `data.js`: take the oldest
   loaded root's `bumpedAt ?? at` as `before`, fetch a page, drop any id
   already loaded, prepend the rest, and set `channelHasMore` false when the
   page is short. It must not touch `channelRead`, `pinned` or `slashCommands`
   — those describe the channel, not the page.
3. Render a "Load earlier messages" control at the top of the transcript in
   `messageList`, shown only while `channelHasMore` is true, with a loading
   state so it cannot be double-fired.
4. Preserve the reader's position across the prepend. The scroll capture and
   restore machinery around `captureChannelScroll` in `app.js` already exists
   for the poll-render case; this needs the same idea anchored on
   `scrollHeight` delta rather than on offset, since content is being added
   above the viewport.

**Touches.** `data.js` (`loadChannel`, new loader, two state keys),
`screen-chats.js` (`messageList` header control), `app.js` (action case, scroll
anchoring), `styles.css`.

**Test.** New `apps/web/src/channel-history.test.ts`: assert `loadChannel`
sends a `limit`, that the earlier-page loader sends `before`, that it dedupes
by id, and that the control is gated on `channelHasMore`.

### 6 — Search sees only loaded roots

**Fix.** Two halves, both in `messageList`'s filter.

- Search replies as well as roots: match a root when its own content matches
  *or* any of its `replies` match, and show which reply matched so the result
  is clickable through to the thread. Nearly all agent output lives in threads,
  so this is most of the value.
- Make the empty state honest. "Nothing matches that search" becomes something
  that names the boundary — nothing matched in the messages loaded so far, with
  the "Load earlier" control offered inline when `channelHasMore` is true. A
  limit reported as an answer is the part of this finding that actually misleads
  people.

**Touches.** `screen-chats.js` (`messageList` filter and empty state).

**Depends on.** Finding 5 for the second half; the reply half stands alone.

---

## Batch 6 — Scoping the changeset

Findings 14 and 15. One global `state.changeSet` is being asked to stand for
every piece of work in the project, and it answers for whichever run
`ensureCodeData` happened to find first.

### 14 — The Diff tab is bound to an arbitrary run

**Fix.** Introduce `state.changeSets`, a map keyed by `taskId`, filled from run
details as they are fetched (each `ChangeSet` already carries its `taskId`, and
`/runs/{id}` returns a run's `changeSets`). Add
`ensureChangeSetForTask(taskId)` in `data.js`, which resolves the run for a
task — from `state.runs`, or by fetching the project's runs list — and caches
its changesets. When a file is opened from a message's changed-files list,
record the originating `taskId` on the file panel state and have the Diff tab
consult `state.changeSets[taskId]` rather than the global. Keep the global as
the fallback for the Code screen, which genuinely means "latest".

**Check first.** Confirm what `state.runs` entries carry — the plan assumes a
run can be matched to a task without a new route, which the run detail payload
supports (`RunDetail.tasks` and `RunDetail.changeSets`). If the runs list does
not carry enough to match, the fallback is one `/runs/{id}` fetch per candidate
run for the repository, cached; still no server change.

**Touches.** `data.js` (state, loader), `screen-code.js` (`ensureCodeData`,
patch lookups), `screen-chats.js` (file panel, Diff tab gating).

**Done when.** Opening a file from an older thread's file list shows that
task's diff, not "Not in this changeset".

### 15 — The agent detail's Files tab shows the global changeset

**Fix.** Once 14 exists, scope the Files tab to the selected agent: the union of
the changesets of tasks belonging to that agent. Until then — and this is worth
doing in the same commit as a safety measure — do not render the section at all
unless the loaded changeset's task belongs to the agent on screen. An empty
panel is a smaller lie than another agent's work under "Files this agent
changes".

**Touches.** `screen-agents.js`.

---

## Batch 7 — Direct messages

### 17 — An unread DM is invisible outside the current roster

**Fix, client-only.** `state.dmConversations` is already loaded with unread
counts, so the whole finding is a rendering gap. Add a `Direct messages` entry
to the `user-menu` (batch 1's menu) carrying the total unread count, opening a
list of conversations with per-person counts; selecting one opens the existing
DM panel. Badge the header avatar with the aggregate so a DM from somebody
outside this channel has a signal on screen.

**Touches.** `app.js` (menu, header badge), `screen-chats.js` (conversation
list), `data.js` (an aggregate `dmUnreadTotal` beside `dmUnreadFrom`).

### 18 — The DM panel is a thinner chat than the room beside it

**Fix, incrementally, in this order.** Day separators first — a bare `14:32` on
a message from last Tuesday is the one item here that actively misinforms.
Reuse the channel's separator logic from `messageList` rather than writing a
second one. Then author grouping, then the unread line. Search, reactions and
the mention/command pickers in the DM panel are each a feature, not a parity
fix, and belong in their own work.

**Touches.** `screen-chats.js` (DM panel renderer), factored helpers shared with
the channel transcript.

---

## Batch 8 — Keyboard (finding 22)

**Fix.** A quick switcher, `Cmd/Ctrl-K`, over channels, people and the four
screens, plus `/` to focus channel search and `?` for a shortcut sheet. Built on
the existing document-level `keydown` handlers in `app.js`, which already own
Escape, the pickers and the composer.

The audit's own correction applies here: the quick switcher was originally
listed as a convenience, and batch 1 changes that reading only partly. Once
Notifications and My Agents have menu entries, the switcher is a convenience
again — which is why it sits here rather than in batch 1, and why batch 1 must
not be deferred in favour of it.

**Touches.** `app.js` (key handlers, overlay), `screen-chats.js` or a new
module for the overlay, `styles.css`.

---

## Batch 9 — Settings and account

### 19 — Two cards managing the same connections

**Fix (D3 recommendation).** Merge "Agents" and "Your agents" into one card,
one row per provider, showing both facts that currently live apart: whether the
deployment offers it, and whether *you* have connected it. One vocabulary, one
place. The `agent-add` handler's comment already documents why the second fact
matters — it is the distinction that made "Add agent" report everything
connected when the user had connected nothing — so the merged card must keep
it, not flatten it.

**Touches.** `app.js` (`settingsScreen`).

### 21 — Non-image attachments disappear quietly

**Fix (D4 recommendation, part a).** In `attachChannelImages`, compute the
skipped files rather than only the kept ones, and say so: name them and give
the reason and the accepted list. Drop a log and a screenshot together and the
reader should be told the log was not attached, in the same breath as the
screenshot uploading. Rename the function while there — it filters, it does not
only attach.

**Touches.** `app.js` (`attachChannelImages`).

### 20 — No account management

**Blocked, honestly.** Display name, avatar, email, password and notification
preferences all need routes that do not exist; the avatar is currently a
`localStorage` value (`ag.avatar`), which is why it appears to work and does
not follow you to another browser. The client work is a settings card and is
small; the server work is a profile read/write with its own authorization
rules. Not schedulable from a UI plan — it needs a server-side owner first.

---

## Batch 10 — Durable notification state (finding 4)

**Blocked on a route, with a cheap half worth taking now.**

The durable fix is server-side read state: a route that records which
notifications a user has read, so reading on a phone is read on a laptop. That
is the only thing that actually fixes the finding.

The cheap half, which can ship with batch 1: key `ag.read` per user id so two
accounts in one browser stop sharing read state, and prune the stored list
against the ids still derivable from the loaded audit window rather than
blindly keeping the last 400 — today, anything that ages out of the window
leaves the list whether it was answered or not, and the truncation can drop an
id that is still on screen.

---

## Carried over, and still not scheduled

Editing your own message, who-reacted names, read receipts, message
permalinks, link unfurls, emoji shortcodes and per-channel mute remain as the
messaging diagnosis left them, with the blockers recorded there unchanged. Two
of that list get closer here without being done: message permalinks become
reachable once the `before` cursor is wired in batch 5, and the quick switcher
is batch 8.

## What has landed

Batches 1 through 9 are implemented, client-side only; no server, route or
schema changed. Where the code departs from the letter of the plan above, the
reason is recorded here rather than left for the next reader to reconstruct.

| Finding | State | Note |
| --- | --- | --- |
| 1 Notifications unreachable | done | Bell in the topbar, and a second one in the channel sidebar's foot — the Chats screen draws no topbar (`BARE`), so the one screen people are on would otherwise be the one without it. Also a menu row. |
| 2 My Agents unreachable | done | Unconditional row in the account menu; "Connect an agent first" left as it was. |
| 3 Notification goes nowhere | done | `notifications()` carries `repositoryId`; `notif-open` opens the channel and the thread whose root carries the same `taskId`. Read-marking stayed unconditional. |
| 7 Failed message looks sent | done | `cmsg-failed` row, "Not sent", and a resend that reuses the local id. Still local-only: a failed post was never persisted, so it does not survive a reload. A durable outbox remains out of scope. |
| 8 Reacting to a reply | done | Guarded on `entry.messageId` — the field that says what a row *is* — rather than on `isReply`, which only says how it is drawn. The thread panel renders its own root in the reply style, and that root is a channel message that can be reacted to. Plus an optimistic rollback in `toggleChannelReaction`. Server-side reply reactions remain wanted and unbuilt. |
| 9 Files-changed disclosure | done | `state.changesOpen`, keyed by message id. |
| 10 Dismissed question | done | Chip above the composer reading the pre-filter list, with an Answer button. The sidebar badge for other rooms is still out (it needs pending questions for channels that are not open). |
| 11 Slash picker cap | done | The cut is gone; the picker already scrolled. |
| 12 Nothing stops an agent | done | D1 taken: a Stop control in the thread header, behind a confirm. My Agents now offers Cancel *or* Retry by status rather than both always, through the same confirm and the same terminal-status set. |
| 13 Settings push copy | done | D2(a) taken: the card names `/push`. No Publish button. |
| 5 Transcript window | done | `limit` on the first page, a `before` cursor for earlier ones, deduped by id, kept in `channelEarlier` so the socket reconcile cannot drop them, with the scroll anchored on the `scrollHeight` delta. |
| 6 Search sees only roots | done | Roots match through their replies, and the empty state names the boundary and offers the way past it. |
| 14 Diff bound to a run | done | `state.changeSets` keyed by `taskId`, filled by `ensureChangeSetForTask` from the task's own `runId` (falling back to the repository's recent runs). The global stays the Code screen's answer, which is what "latest" means there. |
| 15 Agent Files tab | done | Scoped to the tasks that belong to the agent on screen; the global is deliberately *not* the fallback, since falling back to it is the bug. |
| 17 Invisible unread DMs | done | `dmUnreadTotal`, a badge on both account buttons, and a Direct messages row that lists conversations with per-person counts. |
| 18 DM panel parity | partial | Day separators only — the one item that actively misinforms. Author grouping and the unread line remain. |
| 22 Keyboard | done | Ctrl/⌘-K quick switcher over channels, people and the four screens; `/` focuses channel search; `?` opens a shortcut sheet. Drawn in `#layer-root`, outside the shell the poll replaces. |
| 19 Two Settings cards | done | D3(a) taken: one card, one row per provider, saying both whether the deployment offers it and whether *you* have connected it. |
| 21 Silent attachments | done | D4(a) taken: skipped files are named, with the reason and the accepted list. The allowlist is unchanged. |
| 4 Notification read state | partial | The cheap half: `markRead` prunes against the ids still derivable from the loaded window instead of blindly keeping the last 400, which could drop an id still on screen. Not re-keyed per user — `forgetOtherAccount` already clears `ag.read` when a different account signs in, and the store is read at module load, before there is a principal to key on. The durable server-side read state is still the only real fix. |
| 20 Account management | blocked | Unchanged. Needs a profile read/write route with its own authorization rules, and a server-side owner. |

## Validating this work

The browser surface ships as plain ES modules with no bundler, and the test run
has no DOM, so behaviour is pinned by asserting the shape of the source — the
convention `messaging-qol.test.ts` and `chat-scroll.test.ts` already follow.
Each batch above names the file its assertions belong in; new files go beside
those, in `apps/web/src/`, and run under `npm test` in that workspace.
`npm run typecheck` there also runs `scripts/check-public-syntax.mjs`, which is
what catches a syntax error in `public/*.js` that no type checker sees.
