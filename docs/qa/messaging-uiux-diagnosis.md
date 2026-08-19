# Messaging UI/UX diagnosis

A pass over the conversation surface — the channel transcript, its threads and
the direct-message panel — against what somebody arriving from Slack, Discord
or Linear expects a chat to do without being told. The point of the exercise
was to separate three things that get muddled in "the chat feels rough":
conventions we already meet, conventions we do not, and conventions we cannot
meet yet without a schema behind them.

Everything below refers to `apps/web/public/` — `screen-chats.js` for the room,
`chat.js` for the private agent panel, `data.js` for the state and the calls,
`app.js` for the delegated actions, `styles.css` for all of it.

## What was already there

Worth stating, because it is most of the list and it shapes what "lean" meant
for the rest:

- **Grouping and separators.** Consecutive messages from one author collapse to
  a single header, and a date boundary always breaks the run
  (`continuesUserMessageGroup`). The private panel does the same
  (`continuesPrivateChatMessageGroup`).
- **Threads and inline replies.** Agent work keeps a task thread; a person's
  reply lands in the room's own timeline carrying a quoted reference back to
  what it answers, which is the shape every mainstream chat settled on.
- **Composer intelligence.** Mention and slash-command pickers with keyboard
  navigation, an overlay mirror that paints mentions without shifting glyphs,
  IME-composition guards on Enter, Shift+Enter for a newline.
- **Attachments.** Paste, drop and pick; sizes are measured once and remembered
  (`rememberImageSize`), so a decoding image never shoves the transcript.
- **Scroll discipline.** Follow-the-bottom with a slack band, anchor-based
  restore across renders, and a hold for readers who are not following.
- **Pins**, with a banner that survives the message ageing off the loaded page.
- **In-channel search**, unread badges per channel and per DM, typing
  indicators, optimistic send with a failure toast, delete-own-message with a
  tombstone that keeps its thread standing.
- **Accessibility groundwork.** `prefers-reduced-motion` is honoured, hover
  toolbars also reveal on `:focus-within`, and they are permanently visible on
  touch.

## What was missing, and is now implemented

These are the six that were both standard and cheap — all client-side, all on
routes the server already served.

1. **Reactions could only ever be a thumbs-up.** The gateway has always accepted
   an arbitrary `emoji` on `POST …/channel/messages/:id/reactions`, and the
   store has a join table keyed by it. The client passed the literal `"👍"` at
   both call sites, so every reaction in the product was a thumbs-up regardless
   of intent — and clicking a tally somebody else had left added a thumbs-up
   next to it instead of joining theirs. There is now a picker
   (`reactionPicker`) on the hover toolbar and on a "+" chip at the end of an
   existing reaction row, tallies carry the emoji they count, and choices the
   reader has already left are marked so the picker also takes them back.
2. **No "New messages" line.** Unread counts existed, but nothing showed *where*
   the unread began. The obstacle was ordering: `openChannel` calls
   `markChannelRead` immediately, so any divider read from the read stamp would
   always sit at the bottom. The boundary is now snapshotted on the way in
   (`snapshotChannelRead` → `state.channelReadMark`) and held for the visit.
3. **No way back to the bottom.** A reader scrolled up had to drag. There is now
   a pill over the transcript that appears exactly when following is off, says
   how many messages have arrived, and jumps to the unread line when there is
   one rather than to the very bottom. It is painted imperatively, never by
   re-rendering — following flips on every wheel notch.
4. **One draft for every channel.** `state.chatDraft` was global and
   `openChannel` did not touch it, so a half-written message followed the reader
   into the next room and sat there ready to be sent to the wrong people.
   Drafts are now parked per repository (`state.chanDrafts`, mirrored to
   `ag.chandrafts`) and restored on return.
5. **No copy.** Getting a message's words out meant selecting them by hand. A
   copy action now sits in the hover toolbar, stripping the attachment
   reference lines that would otherwise paste as noise.
6. **The transcript was invisible to screen readers.** `#chan-messages` now
   carries `role="log"` with `aria-live="polite"`, so arriving messages are
   announced. Polite rather than assertive: a busy room would otherwise
   interrupt every other announcement on the page.

## What is missing and was deliberately left

Each of these needs something the client cannot add on its own. They are listed
with the blocker so the next pass starts from the right layer.

- **Editing your own message.** The single largest remaining gap. There is no
  `edited_at` column on `channel_messages` (or its Postgres twin), no PATCH
  route, and no store method. Needs schema on both backends, a gateway route
  with the same authorship rule `canDeleteChannelEntry` mirrors, and then the
  usual client affordances — including Up-arrow to edit the last message, which
  is only worth adding once there is something to edit.
- **Who reacted.** `ChannelReaction` is `{emoji, count, mine}` — the reactor ids
  are in the join table but never leave it. A hover tooltip naming them needs
  the type and the read path widened first.
- **Read receipts in a channel.** There is a `…/direct-messages/:id/read` route
  and a channel `/read` route, but nothing exposes *other* people's read
  positions, so "seen by" cannot be drawn honestly.
- **Message permalinks.** Copy-link needs a deep-link route and a client router
  entry that opens a channel scrolled to a message; the scroll half already
  exists (`state.scrollToMessage`), the addressing does not.
- **Link unfurls.** Needs a server-side fetch-and-cache with its own egress
  rules; the CSP and the egress allowlist both have a say.
- **A quick switcher (⌘K).** Genuinely client-only and a good next candidate —
  left out of this pass purely to keep it lean, since it is a new surface
  rather than a gap in an existing one.
- **Emoji shortcodes (`:tada:`) in the composer**, and a searchable picker
  behind the eight fixed choices.
- **Per-channel mute / notification preferences.** No store field exists.

## Verification

`node scripts/check-public-syntax.mjs` parses every browser module.
`apps/web/src/messaging-qol.test.ts` pins the shape of each of the six changes
above, in the same source-assertion style as `chat-scroll.test.ts` — the
dashboard ships as unbundled ES modules and the test run has no DOM.
