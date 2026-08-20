# UI friction audit

A read of the whole product surface as it stands — the channel, its threads
and panels, the direct-message panel, My Agents, Notifications, Settings — for
the places where the interface still costs a person something it does not have
to. It is deliberately the complement of
[`messaging-uiux-diagnosis.md`](messaging-uiux-diagnosis.md), which asked what
a chat app owes its reader; this one asks what *this* app still makes somebody
work around, including the parts that are not chat.

Everything below is a live finding, read against the code as it stands. Items
already recorded as deliberately deferred in the messaging diagnosis are not
repeated except where the picture has since changed; the carry-over list is at
the end.

The remediation half — what to write for each finding, in what order, and what
has to be decided first — is [`ui-friction-fix-plan.md`](ui-friction-fix-plan.md).

Paths are `apps/web/public/` unless another one is given.

## Dead ends: surfaces the interface no longer reaches

The sharpest of the lot, because the work is already built and paid for — only
the way in is missing.

1. **Notifications cannot be opened from anywhere in the app.**
   `#notifications` is a real route (`app.js:2673`) with filters for approvals,
   failures and conflicts (`screen-notifications.js`), and `unreadCount()`
   exists to badge it (`data.js:2311`). Nothing renders a bell, a badge or a
   menu entry: the user menu offers Settings and Sign out only (`app.js:4418`)
   and the sidebar foot has the account button and nothing else. The only route
   in is typing the hash by hand. A comment at `data.js:2223` still describes
   "the bell badge … on every render" for a bell that is no longer drawn. The
   one place that lists failures, conflicts and approvals across every channel
   is, in practice, not part of the product.

2. **My Agents is reachable only while you have no agents.** The single
   navigation into `#agents` from the chat shell is the menu item "Connect an
   agent first", offered only when no connected agent exists
   (`app.js:5650`). Once one provider is connected, the screen holding Add
   Agent, per-agent usage and spend, and the only clickable Cancel/Retry in the
   product (`screen-agents.js:322`) has no entry point at all — so connecting a
   *second* vendor from the chat surface is impossible.

3. **A notification is a dead end when you do reach it.** Clicking a row calls
   `readOne` and nothing else (`app.js:5529`): it marks itself read and stays
   put. "Approval requested", "Task failed" and "Conflict detected" all carry a
   `taskId`, and none of them takes the reader to the thread, the task or the
   decision it is about.

4. **Notification read state is per-browser, over a 60-row window.** `markRead`
   writes the last 400 ids to `localStorage` (`data.js:2316`), and
   `notifications()` derives its rows from whatever `state.audit` currently
   holds, cut to 60 (`data.js:2273`). Read on the phone, still unread on the
   laptop — and anything that ages out of the loaded audit window leaves the
   list whether it was answered or not.

## The transcript

5. **A channel is permanently capped at its newest 50 messages.** `loadChannel`
   fetches `/channel/messages` with no query string (`data.js:3284`), so it
   takes the server's default page. The route already accepts `limit` and a
   `before` cursor (`services/api-gateway/src/server.ts:7596`) and both stores
   implement the cursor, but no client code passes either: there is no infinite
   scroll, no "load earlier", no permalink. Everything older than the last 50
   roots is unreachable from the interface, search included. The largest
   structural gap on the main screen, and unusually one that needs no server
   work.

6. **Search matches only root messages that are already loaded.**
   `messageList` filters `channelMessagesFor(...)` on `entry.content`
   (`screen-chats.js:2284`). Thread replies are not in that list, so nothing an
   agent said inside a thread — which is where nearly all agent output lives —
   can be found, and what remains is scoped to the 50 roots from 5. The reader
   gets "Nothing matches that search", which reads as an answer rather than as
   a limit.

7. **A message that failed to send looks sent.** The optimistic post sets
   `message.failed = true` on rejection (`data.js:3530`, and `reply.failed` at
   `data.js:3584`) and raises a toast. No renderer reads that flag —
   `screen-chats.js` never mentions it. The row keeps its ordinary appearance
   with no failure mark and no resend; once the toast clears there is no
   evidence at all, and the message vanishes on the next reload. A durable
   failure is being reported on a channel that clears itself.

8. **Reacting to a thread reply cannot work, and looks like it did.** The
   reaction button is drawn on every non-deleted row, replies included
   (`screen-chats.js:2062`), but reactions live on `channel_messages` only:
   `toggleChannelReaction` looks the id up in that table and throws otherwise
   (`services/persistence/src/memory-store.ts:2411`), which the route returns as
   a 404. The client has already painted the emoji, so the reader sees the
   reaction land, gets "Reaction did not save" in a corner, and the phantom
   tally stays until the next load. This is the same bug the pin button was
   fixed for — the comment at `screen-chats.js:2083` explains why pin is
   roots-only — and the reasoning was never carried across to reactions.

9. **"N files changed" collapses itself every 30 seconds.** The disclosure is a
   bare `<details>` chosen because it "remembers nothing"
   (`screen-chats.js:1514`), while the whole screen is rebuilt by `render()` on
   every poll (`app.js:6875` → `refresh` → `render` at `app.js:6439`), every
   arriving frame and every search keystroke. The two other `<details>` in the
   transcript persist their state in `state.thinkingOpen` and
   `state.summaryOpen`; this one does not, so a reader who opens a file list to
   read it loses it on the next tick. The same rebuild drops any text selection
   in the transcript with it.

10. **A dismissed agent question leaves no trace.** `question-dismiss` records
    the request in `state.questionDismissed` (`app.js:4706`) and the filter at
    `data.js:2788` hides it until a reload, while the run goes on holding its
    workspace against a deadline — as the handler's own comment says. Nothing
    anywhere shows that a question is outstanding: no badge on the channel, no
    chip above the composer, no row in the thread. "Not now" is a trapdoor.

## Commands, and the things only commands can do

11. **Four of the ten slash commands never appear in the picker.** Candidates
    are prefix-filtered and cut to six (`screen-chats.js:2714`) against ten
    commands (`services/api-gateway/src/slash.ts:46`). With an empty query the
    channel picker shows `plan, queue, ask, dnc, simple, push`, so `retry`,
    `cancel`, `stop` and — pointedly — `help`, whose whole job is to list what
    you can type, are invisible unless you already know the word. In a thread
    the reordering hides `plan`, `queue`, `stop` and `help` instead.

12. **Nothing you can click stops a running agent.** In the channel, stopping
    work means typing `/cancel` or `/stop`, both hidden by 11. The in-chat
    agent panel offers a tab switch and a role field and nothing else
    (`screen-chats.js:3567` onwards); the thread panel's header carries pin,
    continue-here and close (`screen-chats.js:4033`). The only clickable Cancel
    task and Retry are on the orphaned My Agents screen (2), and they are
    unguarded: `task-cancel` fires straight through (`app.js:5499`) with no
    confirmation on work that is mid-run, and Retry is offered on a task in any
    state.

13. **Settings sends you to a terminal for something the room next door does.**
    The Repository card still says publishing canonical "is a CLI operation;
    there is no HTTP route for it, so this is not a button" and prints `coord
    repo push` (`app.js:1210`). `/push` has since become a channel command
    backed by `apps/web/src/push-canonical.ts` and the platform push action, so
    the card is now telling readers the opposite of what the product does.

## Panels and review

14. **The Diff tab is bound to one arbitrary run, not to the work in front of
    you.** `ensureCodeData` takes the first run it finds for the repository and
    keeps the last changeset on it (`screen-code.js:72`), and that single
    `state.changeSet` is what the file panel consults
    (`screen-chats.js:4538`). Open a file from an older thread's "files
    changed" list and the Diff tab is disabled with "Not in this changeset" —
    the file's current text is all there is to see. Reviewing what a particular
    task did becomes impossible as soon as anything else lands, which undercuts
    both the changed-files list and any review before a go-ahead.

15. **The agent detail's Files tab shows that same global changeset.**
    `screen-agents.js:340` renders `state.changeSet.patches` under the heading
    "Files this agent changes" with nothing scoping it to the selected agent,
    so it can attribute another agent's work to the one on screen.

16. **The channel's tools re-hide themselves on every load.** Files, Threads,
    Search, Channel info and the preview control all sit behind a chevron, and
    `chanToolsOpen` defaults to `false` with no persistence (`data.js:278`,
    drawn at `screen-chats.js:1268`) — unlike the sidebar collapse and the panel
    width, which are both remembered. Every reload costs a click before search
    or the file tree, and a first-time reader has no visible evidence that
    in-channel search exists at all.

## Direct messages

17. **An unread DM is invisible unless its sender happens to be in the room you
    are looking at.** `state.dmConversations` carries every conversation with
    its unread count, and the only surfaces that read it are the person rows in
    the current channel's roster (`screen-chats.js:705` and `1787`, via
    `dmUnreadFrom`). There is no DM list, no aggregate badge and no user-menu
    entry, so a message from somebody outside this channel arrives with no
    signal anywhere on screen.

18. **The DM panel is a much thinner chat than the room beside it.** No date
    separators — every message shows a bare clock time
    (`screen-chats.js:3972`), so last Tuesday reads as "14:32" — no author
    grouping, no unread line, no search, no reactions, and no mention or
    command picker. The channel transcript has all of them.

## Smaller, and repeatedly annoying

19. **Two cards in Settings manage the same connections.** "Agents"
    (`app.js:1382`) offers Connect / Disconnect / Rename per provider; "Your
    agents" (`app.js:1228`) offers Connect / "Connect yours" / Disconnect for
    the same providers, with different wording and a different notion of what
    "connected" means. Both are on the same page, a screen apart.

20. **There is no account management.** Settings can rename an agent but not
    you: no display name, avatar, email or password change, and no notification
    preference. Sign out is the only account control (`app.js:1303`).

21. **Non-image attachments disappear quietly.** The composer filters to images
    (`app.js:2192`) behind a server allowlist of four image types
    (`apps/web/src/attachments.ts:20`). Drop a log and a screenshot together and
    the screenshot uploads while the log is dropped without a word; drop the log
    alone and the message is "Only images can be attached." Sharing a stack
    trace with an agent means pasting it as text.

22. **No keyboard route to anything but text.** The document-level handlers
    (`app.js:2905` onwards) cover composer Enter, the mention and slash
    pickers, the question prompt, panel-grip resize and Escape. There is no
    quick switcher, no shortcut to search, no next/previous channel, no
    Up-arrow to edit and no shortcut help — so every navigation on a screen
    built around a sidebar is a pointer action.

## Carried over from the messaging diagnosis, still open

Checked rather than assumed: editing your own message (no `edited_at`, no PATCH
route, no client affordance), who-reacted names, read receipts, message
permalinks, link unfurls, a quick switcher, emoji shortcodes and per-channel
mute are all still absent, with the blockers recorded there unchanged. One
correction to that list: the quick switcher was described as a convenience left
out to keep the pass lean, and it has since become the only plausible route to
several screens — see 1 and 2.

## Suggested order

- Client-only and cheap: 1, 2, 3, 7, 8, 9, 11, 16.
- Cheap, but each needs a decision about shape first: 10, 12, 13, 19.
- Structural and still client-only, because the routes and the cursor already
  exist: 5, 6.
- Needs the server or a schema: 14, 15, 17, 20 and the carry-over list.

## Method

A static read of `apps/web/public/{app,data,ui,chat,screen-*,code-view,boot-plan}.js`
and `styles.css` against the routes in `services/api-gateway/src/server.ts`, the
command table in `services/api-gateway/src/slash.ts`, and the channel storage in
`services/persistence/src/memory-store.ts`. No behaviour was changed and no
tests were added; every claim names the file and line it was read from, so the
next pass starts there rather than re-deriving it.
