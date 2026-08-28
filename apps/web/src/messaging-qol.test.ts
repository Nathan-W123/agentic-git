import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The conveniences a chat is expected to have, pinned the way the rest of the
 * browser surface is pinned: by asserting the shape of the source, since the
 * dashboard ships as plain ES modules with no bundler and the test run has no
 * DOM. Each test here stands for one thing a reader could not previously do —
 * react with anything but a thumbs-up, see where they had got to, get back
 * down to the newest messages, keep a draft in the room it was meant for, or
 * take a message's words with them.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

/** One top-level function's source, from its declaration to the next one. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `${from} should exist`);
  assert.notEqual(end, -1, `${from} should end at ${to}`);
  return source.slice(start, end);
}

test("a reaction can be any emoji, not only the one the client could send", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // The server has always taken an `emoji` on the reaction route. The client
  // sent the same hardcoded character every time, so every reaction in the
  // product was a thumbs-up whatever anybody meant by it.
  assert.match(chats, /const REACTION_CHOICES = \[/u);
  assert.match(chats, /export function reactionPicker\(anchor, repositoryId, messageId\)/u);
  assert.match(chats, /data-act="channel-react-choose"/u);
  assert.match(app, /case "channel-react-pick":/u);
  assert.match(app, /reactionPicker\(node, activeChannelId\(\), value\)/u);
  assert.match(app, /case "channel-react-choose":/u);
  assert.match(
    app,
    /toggleChannelReaction\(activeChannelId\(\), value, emoji, render\)/u,
  );

  // A tally under a message toggles the emoji it counts. It used to carry no
  // emoji at all, so clicking somebody else's 🎉 added a 👍 beside it.
  assert.match(chats, /data-act="channel-react"[\s\S]{0,160}data-emoji="\$\{esc\(emoji\)\}"/u);
  assert.match(app, /const emoji = node\.dataset\.emoji \|\| "👍"/u);

  // The picker doubles as the way to take a reaction back, so the ones this
  // reader has already left are marked in it.
  assert.match(chats, /reactions\[emoji\]\?\.mine === true \? " mine" : ""/u);
  assert.match(css, /\.react-choice\.mine \{/u);
  assert.match(css, /\.cmsg-react-add \{/u);

  // The common quick reactions remain first, while the larger catalogue can
  // be reached by a word such as "party", "warning" or "thanks". Filtering
  // happens inside the open popover so typing does not rebuild the channel.
  assert.match(chats, /const REACTION_SEARCH_TERMS = \{/u);
  assert.match(
    chats,
    /type="search" data-reaction-search placeholder="Search emoji"/u,
  );
  assert.match(chats, /data-search="\$\{esc\(`/u);
  assert.match(
    chats,
    /const choices = \[\.\.\.popover\.querySelectorAll\("\.react-choice"\)\]/u,
  );
  assert.match(
    chats,
    /choice\.hidden = query !== "" && !terms\.includes\(query\)/u,
  );
  assert.match(chats, /empty\.hidden = matches !== 0/u);
  assert.match(chats, /data-reaction-empty role="status" hidden>No emoji found/u);
  assert.match(css, /\.react-search input \{/u);
  assert.match(css, /\.react-empty \{/u);
});

test("channel messages and workspace links use compact, bounded surfaces", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // Threads and Files are one semantic navigation group with matching rows,
  // instead of two loose controls occupying their own unrelated spacing.
  assert.match(
    chats,
    /<nav class="chan-sidebar-head chan-quick-links" aria-label="Workspace">/u,
  );
  // A group, not a card. The outline and the sunken fill around them made a
  // pane inside the panel inside the boundary around the whole application —
  // three nested edges to read before two links — so the group keeps its
  // spacing and gives up its box.
  const quickLinks =
    /\n\.chan-sidebar-head\.chan-quick-links \{(?<rule>[^}]*)\}/u.exec(css)?.groups
      ?.rule ?? "";
  assert.notEqual(quickLinks, "", "the quick links still have a rule of their own");
  assert.match(quickLinks, /margin: 8px 8px 4px;/u);
  assert.doesNotMatch(quickLinks, /(?:^|\s)(?:border|background):/u);
  // And the rows are the height every other row in this column is, rather
  // than the compressed height a nested card had room for.
  assert.match(
    css,
    /\.chan-quick-link \{[\s\S]{0,260}min-height: 38px;[\s\S]{0,100}padding: 8px 10px;/u,
  );

  // Channel messages stay fitted so their hover tools remain nearby, but the
  // transcript itself is unboxed. Private conversations keep their bubbles.
  const channelBodyRule =
    css.match(/\.cmsg-row \.cmsg-body \{(?<rule>[^}]*)\}/u)?.groups?.rule ?? "";
  assert.match(channelBodyRule, /width: fit-content;/u);
  assert.doesNotMatch(
    channelBodyRule,
    /(?:^|\s)(?:padding|border|border-radius|background|box-shadow):/u,
  );
  assert.match(
    css,
    /\.cmsg-row\.cmsg-compact \.cmsg-body \{\s*margin-left: calc\(var\(--cmsg-body-x\) - 8px\);\s*\}/u,
  );
  assert.doesNotMatch(
    css,
    /\.cmsg-row:not\(\.cmsg-system\):hover \.cmsg-body/u,
  );
  assert.match(
    css,
    /\.dm-bubble \{[^}]*border-radius: var\(--radius-sm\);[^}]*background: var\(--surface-2\);/u,
  );
  assert.match(
    chats,
    /<div class="cmsg-body">[\s\S]*<span class="cmsg-actions">[\s\S]*<\/span>\s*<\/div>\s*<\/div>`;/u,
  );
  assert.doesNotMatch(chats, /cmsg-mine/u);
  assert.doesNotMatch(css, /cmsg-mine/u);
});

test("the unread line is taken before opening the room marks it read", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // The order is the whole feature. `markChannelRead` stamps the channel to
  // now, so a divider read from `channelRead` after the open would always sit
  // at the bottom — which is to say it would never be drawn.
  const open = slice(chats, "export function openChannel", "\nexport function submitComposerMessage");
  const snapshot = open.indexOf("snapshotChannelRead(repositoryId)");
  const mark = open.indexOf("markChannelRead(repositoryId)");
  assert.notEqual(snapshot, -1, "opening a channel takes the divider's position");
  assert.equal(
    snapshot < mark,
    true,
    "the boundary must be read before the read stamp moves past it",
  );

  // Two fields, because they answer different questions: one is "is there
  // anything here for me", the other is "where was I".
  assert.match(data, /channelReadMark: \{\}/u);
  assert.match(data, /export function channelUnreadMark\(repositoryId\)/u);
  // A first visit is not a backlog somebody fell behind on.
  assert.match(data, /readAt > 0 && countChannelSince\(repositoryId, readAt, false\) > 0/u);

  // Drawn once, at the first message somebody else sent after that moment.
  //
  // This used to pin the `query === ""` guard that suppressed the mark over
  // search results. Message search is gone and its `query` went with it, so
  // the guard was a read of a variable that no longer existed — the assertion
  // was holding a ReferenceError in place, and `messageList` threw on every
  // channel that had messages in it. What matters is that the mark is taken
  // here, before opening the room overwrites it; the source it is taken from
  // is not the point.
  assert.match(chats, /const mark = channelUnreadMark\(repositoryId\)/u);
  assert.match(chats, /class="chan-unread" id="chan-unread"/u);
  assert.match(chats, /!markDrawn &&[\s\S]{0,80}Date\.parse\(item\.at \?\? ""\) > mark/u);
  assert.match(css, /\.chan-unread \{/u);
});

test("quiet transcript metadata uses an outlined label on a straight separator", async () => {
  const [chat, chats, css] = await Promise.all([
    publicFile("chat.js"),
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  // Dates share one treatment in private agent chats, rooms, and direct
  // messages, while coordinator-authored notices use it instead of looking
  // like another participant in the conversation.
  assert.match(chat, /thread-day transcript-separator/u);
  assert.match(chat, /msg system transcript-separator/u);
  assert.match(chats, /chan-day transcript-separator/u);
  assert.match(chats, /cmsg-system[\s\S]{0,100}transcript-separator/u);

  // The label owns the outline; the two pseudo-elements are the uninterrupted
  // hairline on either side, so long notices can wrap without drawing through
  // their words.
  assert.match(css, /\.transcript-separator::before,[\s\S]{0,80}\.transcript-separator::after/u);
  assert.match(css, /\.transcript-separator > span \{[\s\S]{0,260}border: 1px solid/u);

  // Channel rows use the whole chat panel rather than a fixed desktop column.
  // That gives ordinary messages the available line length and also centers
  // the full-width coordinator separator in the room.
  assert.match(css, /--room-column: 100%/u);
  assert.match(css, /\.cmsg-row \{[\s\S]{0,180}max-width: var\(--room-column\)/u);
});

test("a reader who has scrolled up is offered the way back down", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // Shown and hidden by attribute, never by re-rendering: following changes on
  // every wheel notch, and rebuilding the transcript at that rate is the
  // latency this screen spent a lot of effort not having.
  assert.match(chats, /function jumpToLatest\(\)/u);
  assert.match(chats, /export function paintJumpToLatest\(\)/u);
  assert.match(chats, /pill\.hidden = followingChannel/u);
  const paint = slice(chats, "export function paintJumpToLatest", "\nlet leftBottomAt");
  assert.doesNotMatch(
    paint,
    /\b(?:render|rerender)\s*\(/u,
    "painting the pill must not rebuild the screen",
  );
  // The label is compared against the node, not against state: every render
  // hands back a fresh blank pill, and a count remembered elsewhere would
  // leave that blank label looking correct and never repaint it.
  assert.match(paint, /pill\.dataset\.count !== String\(count\)/u);

  // The count is measured from the visit's unread mark when there is one, and
  // otherwise from the moment the reader left the bottom — so a room they had
  // fully read still tells them what arrived behind their back.
  assert.match(paint, /channelUnreadMark\(repositoryId\) \?\? leftBottomAt/u);

  // The same flag the restore path uses to decide whether to pin the bottom,
  // so the pill is visible exactly when an arriving message would not be
  // scrolled to.
  const restore = slice(chats, "export function restoreChannelScroll", "\nexport function openChannel");
  assert.match(restore, /followingChannel = distance <= FOLLOW_SLACK_PX;\s*\n\s*paintJumpToLatest\(\)/u);

  // The unread line is the better destination of the two: somebody coming back
  // to a busy room wants the start of what they missed, not the end of it.
  assert.match(chats, /export function jumpToUnreadOrLatest\(\)/u);
  assert.match(chats, /document\.getElementById\("chan-unread"\)/u);
  assert.match(app, /case "channel-jump-latest":/u);

  // Floating over the transcript rather than taking a row: a pill that pushed
  // the conversation up by its own height would shift the very words somebody
  // scrolled up to read.
  assert.match(css, /\.chan-jump \{[\s\S]{0,120}position: absolute/u);
  assert.match(css, /\.chan-jump\[hidden\] \{\s*display: none;/u);
});

test("a half-written message stays in the channel it was meant for", async () => {
  const data = await publicFile("data.js");
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // One live draft was the only copy, so an unsent message followed the reader
  // into the next channel and waited there to be sent to the wrong people.
  assert.match(data, /chanDrafts: JSON\.parse\(window\.localStorage\.getItem\("ag\.chandrafts"\) \?\? "\{\}"\)/u);
  assert.match(data, /export function saveChannelDraft\(repositoryId, text\)/u);
  assert.match(data, /export function channelDraft\(repositoryId\)/u);

  // Parked before `state.repositoryId` moves: after that there is no longer a
  // way to tell which room the words in the composer belonged to.
  const open = slice(chats, "export function openChannel", "\nexport function submitComposerMessage");
  assert.match(open, /const leaving = state\.repositoryId/u);
  assert.match(open, /saveChannelDraft\(leaving, state\.chatDraft\)/u);
  assert.equal(
    open.indexOf("saveChannelDraft(leaving") < open.indexOf("state.repositoryId = repositoryId"),
    true,
    "the outgoing draft is parked before the channel changes under it",
  );
  assert.match(open, /state\.chatDraft = channelDraft\(repositoryId\)/u);

  // Sending empties the parked copy too, or the next visit restores a message
  // that has already gone.
  const submit = slice(chats, "export function submitComposerMessage", "\n/**");
  assert.equal(
    [...submit.matchAll(/saveChannelDraft\(repositoryId, ""\)/gu)].length,
    2,
    "both the reply and the new-message path clear the parked draft",
  );

  // Typing writes the in-memory copy; the disk mirror is held behind a timer
  // so the composer stays cheap, and flushed when the tab goes away.
  assert.match(data, /window\.setTimeout\(flushChannelDrafts, 500\)/u);
  // Sliced to the handler rather than matched across a character budget: the
  // catch-up mark was added between the two, and a budget that has to be
  // raised every time something lands in between is not pinning the order it
  // means to. What matters is that the flush is on the going-away path and
  // not on the coming-back one.
  const visibility = slice(
    app,
    'document.addEventListener("visibilitychange", () => {',
    "\n});",
  );
  assert.match(
    visibility,
    /if \(document\.visibilityState === "visible"\) \{\s*resumeLiveUpdates\(\);\s*return;/u,
  );
  assert.match(visibility, /flushChannelDrafts\(\);/u);
  assert.equal(
    visibility.indexOf("return;") < visibility.indexOf("flushChannelDrafts()"),
    true,
    "the draft is flushed after the visible early return, so only leaving triggers it",
  );
});

test("a message's words can be taken off the screen", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  assert.match(chats, /export async function copyMessageText\(repositoryId, messageId\)/u);
  assert.match(chats, /navigator\.clipboard\.writeText\(text\)/u);
  assert.match(app, /case "channel-message-copy":/u);
  assert.match(chats, /act: "channel-message-copy"/u);

  // Thread replies render through the same row, so the lookup has to reach
  // into them and not only the roots.
  const copy = slice(chats, "export async function copyMessageText", "\n/**");
  assert.match(copy, /roots\.flatMap\(\(message\) => message\.replies \?\? \[\]\)/u);
  // Attachment references are an internal address for a picture; they paste as
  // noise. Removed rather than truncated at, because a sent message can carry
  // one in the middle of a sentence.
  assert.match(copy, /\.replace\(ATTACHMENT_PATTERN, ""\)/u);
  // A denied clipboard beats a button that looks like it worked.
  assert.match(copy, /Could not reach the clipboard/u);
});

test("the transcript announces itself to a screen reader", async () => {
  const chats = await publicFile("screen-chats.js");
  // Both branches: an empty room is exactly where the first arriving message
  // matters most, and a live region declared only on the populated one would
  // miss it.
  assert.equal(
    [...chats.matchAll(/id="chan-messages" role="log"/gu)].length,
    2,
    "the empty and populated transcripts are both live regions",
  );
  assert.match(chats, /aria-live="polite" aria-relevant="additions"/u);
  // Polite, not assertive: a busy room would otherwise interrupt every other
  // announcement on the page.
  assert.doesNotMatch(chats, /id="chan-messages"[\s\S]{0,120}aria-live="assertive"/u);
});

test("the Thread label opens the thread library as the visible side panel", async () => {
  const [app, chats] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
  ]);
  const kind = slice(chats, "function panelKind(", "\n/**\n * The control every");
  const panel = slice(chats, "function threadPanel(", "\nfunction planPanel(");
  const action = app.slice(
    app.indexOf('case "channel-threads-toggle":'),
    app.indexOf('case "channel-thread-delete":'),
  );

  // The category in the screenshot is a real control, not inert header text.
  assert.match(kind, /<button type="button" class="panel-kind" data-act=/u);
  // `panelKind` gained a third `panelId` argument so several open thread
  // panels can be told apart for drag and keep; the label is still the same
  // `channel-threads-toggle` breadcrumb button, and both are still pinned.
  assert.match(
    panel,
    /panelKind\(\s*"Thread",\s*"channel-threads-toggle",\s*`thread:\$\{messageId\}`/u,
  );

  // A list marked open with no room left to draw it — or, on a phone, with a
  // newer surface over it — is not visibly open. Pressing Thread there
  // navigates back to the library instead of toggling hidden state.
  assert.match(action, /const listVisible =/u);
  assert.match(action, /phoneLayout\(\)/u);
  assert.match(action, /newestRightPanel\(\) === "threads"/u);
  assert.match(action, /keptRightPanels\(\)\.includes\("threads"\)/u);
  assert.match(
    action,
    /if \(listVisible\) \{\s*state\.chanThreadList = false;\s*render\(\);\s*return;/u,
  );

  // Opening it is lossless in the stronger sense the column now allows:
  // nothing else is put away to make space, so there is no unsaved edit to
  // ask about and nothing to close before the library is rendered.
  assert.match(action, /state\.chanThreadList = true;/u);
  assert.doesNotMatch(action, /confirmDiscardEdit/u);
  assert.doesNotMatch(action, /closeChannelFile\(\)/u);
  for (const field of [
    "activePlan",
    "activeAgentPanel",
    "activeDm",
    "activeChannelThread",
  ]) {
    assert.doesNotMatch(action, new RegExp(`state\\.${field} = undefined`, "u"));
  }
});

/*
 * The right-hand column holds up to three surfaces at once.
 *
 * It used to hold one, then — once a tab could be dragged left — two. A thread
 * and the file it is about and the person who asked for it are three different
 * things to have open, and closing one of them to read another lost the place
 * in it. So the kept surfaces stack: the older ones are pushed left, the newest
 * keeps the right edge, and the room takes whatever width is left over.
 *
 * The regular expressions below name the browser modules loosely on purpose.
 * The pinned thing is the arrangement — a ceiling of three, both positions
 * drawn from the one helper, a closed surface stopping being kept — not the
 * particular identifiers the client chose to spell it with.
 */
test("desktop panel tabs can be dragged left to keep three conversations open", async () => {
  const [app, chats, css] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  // A tab names its own surface and can be picked up: that is what a second
  // and a third occupant of the column are made from.
  assert.match(chats, /data-right-panel-kind=/u);
  assert.match(chats, /draggable="true"/u);
  assert.match(chats, /function rightPanels\(repositoryId\)/u);
  // A phone has no column to push anything into — one surface over the room.
  assert.match(chats, /phoneLayout\(\)/u);
  // Kept surfaces are drawn to the left of the newest one, which holds the
  // edge, and both go through the one positioning helper so the two sides
  // cannot drift apart.
  assert.match(chats, /positionedRightPanel\([^)]*"left"\)/u);
  assert.match(chats, /positionedRightPanel\([^)]*"right"\)/u);

  assert.match(app, /RIGHT_PANEL_DRAG_TYPE/u);
  // What is kept open is a list of surfaces, not a single one.
  assert.match(app, /state\.(?:rightPanelStack|splitRightPanels|pinnedRightPanels)\b/u);
  // Closing a surface also stops it being kept, or the column would hold a
  // name with nothing behind it.
  assert.match(app, /(?:clearSplitRightPanel|clearRightPanel|unpinRightPanel)\("dm"\)/u);
  assert.match(
    app,
    /(?:clearSplitRightPanel|clearRightPanel|unpinRightPanel)\("thread"\)|putAwayRightPanel\(`thread:\$\{/u,
  );

  assert.match(css, /\.chats-shell\.panel-splitting \.chan-main/u);
  assert.match(css, /\.thread-panel\[data-right-panel-position=/u);
  assert.match(
    css,
    /@media[^}]*max-width:\s*600px[\s\S]*?\.chats-shell\.panel-splitting \.chan-main[\s\S]*?box-shadow:\s*none/u,
  );
});

test("separate thread tabs replace the group transcript when two are open", async () => {
  const [app, chats, data, css] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("data.js"),
    publicFile("styles.css"),
  ]);

  assert.match(data, /activeChannelThreads:\s*\[\]/u);
  assert.match(data, /map\(\(id\) => `thread:\$\{id\}`\)/u);
  assert.match(app, /openThreadPanel\(value\)/u);
  assert.match(chats, /threadPanel\(repositoryId, kind\.slice\("thread:"\.length\)\)/u);
  assert.match(chats, /data-thread-id=/u);
  assert.match(
    css,
    /\.chats-shell\.panels-2 \.chan-main,[\s\S]*?\.chats-shell\.panels-3 \.chan-main\s*\{\s*display:\s*none;/u,
  );
});

test("a fourth kept panel is refused rather than squeezing the room away", async () => {
  const [app, chats, data] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("data.js"),
  ]);

  // Three is the ceiling, and it is written down as a number rather than left
  // implied by the drawing code — a fourth column would leave the transcript
  // it is all about too narrow to read.
  assert.match(
    `${app}\n${chats}\n${data}`,
    /(?:RIGHT_PANEL_MAX|MAX_RIGHT_PANELS|RIGHT_PANEL_LIMIT|PANEL_STACK_MAX)\s*=\s*3\b|\.slice\(\s*(?:0,\s*)?-?3\s*\)/u,
  );
});

test("a tab opening beside another animates in at that tab's width", async () => {
  const [app, chats, css] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("styles.css"),
  ]);

  // Each panel is told apart from its neighbours across a render, so a second
  // one opening is an arrival rather than "the column was already occupied".
  // The attribute is its own, not the draggable tab's: sharing that one would
  // turn every drag started inside a panel into a drag of the panel.
  assert.match(chats, /data-panel-key="\$\{esc\(kind\)\}"/u);
  assert.match(app, /key:\s*\(node\) => node\.dataset\.panelKey/u);
  assert.match(app, /function liveNodes\(root, surface\)/u);
  assert.match(app, /querySelectorAll\(\s*`\$\{surface\.selector\}:not\(\.\$\{surface\.leave\}\)`/u);
  // Arrivals and departures are both decided per key now.
  assert.match(app, /if \(before\.has\(key\)/u);
  assert.match(app, /if \(now\.has\(key\)/u);

  // And it arrives the size the tab beside it already is, rather than both of
  // them splitting the window — the dragged width, growing from nothing over
  // the length of the animation so the neighbour is not shoved sideways in a
  // single frame.
  assert.match(
    css,
    /\.chats-shell\.panels-2 \.thread-panel,\s*\.chats-shell\.panels-3 \.thread-panel\s*\{[^}]*width:\s*var\(--panel-w/u,
  );
  assert.match(
    css,
    /\.chats-shell\.panels-2 \.thread-panel\.panel-entering,\s*\.chats-shell\.panels-3 \.thread-panel\.panel-entering\s*\{[^}]*animation:\s*panel-join var\(--motion-panel\)/u,
  );
  assert.match(css, /@keyframes panel-join\s*\{[^}]*\{[^}]*width:\s*0;/u);
});

/** One node in a stand-in for the part of a row this gesture actually reads. */
interface FakeNode {
  id: string;
  isConnected: boolean;
  tokens: Set<string>;
  parent: FakeNode | undefined;
  dataset: Record<string, string>;
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
  };
  closest: (selector: string) => FakeNode | null;
}

/** A long press the platform would answer with a menu of its own. */
interface FakeMenuEvent {
  target: FakeNode;
  prevented: boolean;
  preventDefault: () => void;
}

/**
 * Whether one node answers one comma-separated selector, for the handful of
 * selectors the hold uses: class and element names, plus the transcript's
 * `:not(.cmsg-system)`.
 */
function fakeMatches(node: FakeNode, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some((part) =>
      part === ".cmsg-row:not(.cmsg-system)"
        ? node.tokens.has(".cmsg-row") && !node.tokens.has(".cmsg-system")
        : part
            .split(".")
            .filter((name) => name !== "")
            .every((name) =>
              node.tokens.has(part.startsWith(".") ? `.${name}` : name),
            ),
    );
}

function fakeNode(tokens: string[], parent?: FakeNode): FakeNode {
  const own = new Set(tokens);
  const node: FakeNode = {
    id: "",
    isConnected: true,
    tokens: own,
    parent,
    dataset: {},
    classList: {
      add: (name: string): void => {
        own.add(`.${name}`);
      },
      remove: (name: string): void => {
        own.delete(`.${name}`);
      },
      contains: (name: string): boolean => own.has(`.${name}`),
    },
    closest: (selector: string): FakeNode | null => {
      let current: FakeNode | undefined = node;
      while (current !== undefined) {
        if (fakeMatches(current, selector)) {
          return current;
        }
        current = current.parent;
      }
      return null;
    },
  };
  return node;
}

test("mobile message actions surface only for the selected message", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");
  const source = slice(
    app,
    "/** How long a finger stays on a message before it offers its options. */",
    "\nfunction selectDirectMessage(",
  );

  // The gesture is run for real rather than read: a screen with no hover, a
  // finger that lands, and a timer somebody else decides when to fire. Every
  // browser thing it touches is a stand-in — there is no DOM in this run.
  const rows: FakeNode[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  let pending: (() => void) | undefined;
  let buzzes = 0;
  const fakeDocument = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    querySelectorAll: (selector: string): FakeNode[] =>
      rows.filter((row) => row.isConnected && fakeMatches(row, selector)),
    getElementById: (id: string): FakeNode | null =>
      rows.find((row) => row.isConnected && row.id === id) ?? null,
  };
  const fakeWindow = {
    matchMedia: (query: string) => ({ matches: query === "(hover: none)" }),
    setTimeout: (run: () => void): number => {
      pending = run;
      return 1;
    },
    clearTimeout: (): void => {
      pending = undefined;
    },
  };
  const fakeState: { dmSelectedMessageId: string | undefined } = {
    dmSelectedMessageId: undefined,
  };
  const held = new Function(
    "document",
    "window",
    "state",
    "navigator",
    "clearDirectMessageSelection",
    `${source}\nreturn { selectMobileChannelMessage, clearMessageHoldSelection };`,
  )(
    fakeDocument,
    fakeWindow,
    fakeState,
    {
      vibrate: (): boolean => {
        buzzes += 1;
        return true;
      },
    },
    () => {
      fakeState.dmSelectedMessageId = undefined;
    },
  ) as {
    selectMobileChannelMessage: (event: unknown) => void;
    clearMessageHoldSelection: () => void;
  };

  const fire = (type: string, event: unknown): void => {
    for (const handler of handlers.get(type) ?? []) {
      handler(event);
    }
  };
  /** The wait finishing. A fired timer is spent, exactly as a real one is. */
  const holdElapses = (): void => {
    const run = pending;
    pending = undefined;
    run?.();
  };
  const press = (target: FakeNode, x = 10, y = 10, kind = "touch"): unknown => ({
    target,
    pointerType: kind,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  // A click carries no `pointerType` in every browser, so the tap half of this
  // goes through the screen's own answer instead.
  const tap = (target: FakeNode): unknown => ({ target });

  const row = fakeNode([".cmsg-row"]);
  rows.push(row);
  const text = fakeNode([".cmsg-text"], row);
  const bar = fakeNode([".cmsg-actions"], row);
  const other = fakeNode([".chat-body"]);

  // The whole point: a tap is no longer the ask. It lands, it lifts, and the
  // transcript is exactly as it was.
  fire("pointerdown", press(text));
  assert.equal(row.classList.contains("msg-holding"), true, "the press shows");
  fire("pointerup", press(text));
  held.selectMobileChannelMessage(tap(text));
  assert.equal(row.classList.contains("cmsg-selected"), false);
  assert.equal(row.classList.contains("msg-holding"), false);

  // Holding it is. The row stops showing the press once the options are out,
  // and the phone ticks under the finger the way it does for every other hold.
  fire("pointerdown", press(text));
  holdElapses();
  assert.equal(row.classList.contains("cmsg-selected"), true);
  assert.equal(row.classList.contains("msg-holding"), false);
  assert.equal(buzzes, 1);

  // The release of that same hold arrives as a click, and must not close what
  // the hold just opened.
  fire("pointerup", press(text));
  held.selectMobileChannelMessage(tap(text));
  assert.equal(row.classList.contains("cmsg-selected"), true);

  // A press on the bar itself is that button's press: the bar stays up for the
  // delegated action behind it, and starts no hold of its own.
  fire("pointerdown", press(bar));
  assert.equal(pending, undefined, "the open bar is not itself holdable");
  held.selectMobileChannelMessage(tap(bar));
  assert.equal(row.classList.contains("cmsg-selected"), true);

  // Anything else puts them away.
  fire("pointerdown", press(other));
  fire("pointerup", press(other));
  held.selectMobileChannelMessage(tap(other));
  assert.equal(row.classList.contains("cmsg-selected"), false);

  // A finger that travels was scrolling the transcript, not asking about the
  // message it happened to start on.
  fire("pointerdown", press(text));
  fire("pointermove", { clientX: 10, clientY: 44 });
  assert.equal(pending, undefined, "a scroll cancels the hold");
  assert.equal(row.classList.contains("msg-holding"), false);

  // A command or a path somebody posted is still the platform's to select and
  // copy: holding one reaches for the words, not for the message around them.
  fire("pointerdown", press(fakeNode(["code"], text)));
  assert.equal(pending, undefined, "code keeps its own long press");

  // A mouse keeps hover and its own press-and-drag over the words.
  fire("pointerdown", press(text, 10, 10, "mouse"));
  assert.equal(pending, undefined, "a pointer never holds");

  // A private message answers the same hold, but its choice is kept in state:
  // the conversation is rebuilt on every poll and a class would not survive.
  const dmRow = fakeNode([".dm-msg"]);
  dmRow.dataset["dmMessage"] = "m-7";
  rows.push(dmRow);
  const bubble = fakeNode([".dm-bubble"], dmRow);
  fire("pointerdown", press(text));
  holdElapses();
  fire("pointerdown", press(bubble));
  holdElapses();
  assert.equal(fakeState.dmSelectedMessageId, "m-7");
  assert.equal(dmRow.classList.contains("dm-selected"), true);
  assert.equal(
    row.classList.contains("cmsg-selected"),
    false,
    "one message at a time, across both surfaces",
  );
  held.clearMessageHoldSelection();
  assert.equal(fakeState.dmSelectedMessageId, undefined);
  assert.equal(dmRow.classList.contains("dm-selected"), false);

  // A poll can rebuild the transcript while the finger is still down. The
  // options belong to the message being held, not to the row object that the
  // render has since thrown away.
  row.id = "cmsg-4";
  fire("pointerdown", press(text));
  row.isConnected = false;
  const rebuilt = fakeNode([".cmsg-row"]);
  rebuilt.id = "cmsg-4";
  rows.push(rebuilt);
  holdElapses();
  assert.equal(rebuilt.classList.contains("cmsg-selected"), true);
  held.clearMessageHoldSelection();

  // And the platform's own long-press menu stays out of the way of this one —
  // except over a link, a picture or a snippet of code, which keep the menus
  // they have always had.
  const menu = (target: FakeNode): FakeMenuEvent => {
    const event: FakeMenuEvent = {
      target,
      prevented: false,
      preventDefault: (): void => {
        event.prevented = true;
      },
    };
    fire("contextmenu", event);
    return event;
  };
  assert.equal(menu(text).prevented, true);
  assert.equal(menu(fakeNode(["a"], text)).prevented, false);
  assert.equal(menu(fakeNode(["code"], text)).prevented, false);
  assert.equal(menu(other).prevented, false);

  // The selector still runs before the delegated handler's no-action early
  // return: a press on plain message text has no `data-act`, so a dismissal
  // running after that return would never see it.
  const click = app.slice(
    app.indexOf('document.addEventListener("click", (event) => {'),
    app.indexOf("const { node, act, value } = found;"),
  );
  assert.notEqual(click.indexOf("selectMobileChannelMessage(event);"), -1);
  assert.notEqual(click.indexOf("const found = actionOf(event);"), -1);
  assert.equal(
    click.indexOf("selectMobileChannelMessage(event);") <
      click.indexOf("const found = actionOf(event);"),
    true,
    "the dismissal runs before the no-action early return",
  );

  // Touch overrides both the later desktop hover rule and mobile browsers'
  // sticky synthetic hover. Only the held row restores the toolbar's placement
  // and hit testing; the desktop hover/focus reveal remains intact.
  assert.match(
    css,
    /@media \(hover: none\) \{[\s\S]*?\.cmsg-row \.cmsg-actions \{\s*opacity: 0 !important;\s*pointer-events: none !important;/u,
  );
  assert.match(
    css,
    /\.cmsg-row\.cmsg-selected \.cmsg-actions \{[\s\S]*?position: static !important;[\s\S]*?opacity: 1 !important;[\s\S]*?pointer-events: auto !important;/u,
  );
  assert.match(
    css,
    /\.cmsg-row:hover \.cmsg-actions,\s*\.cmsg-row:focus-within \.cmsg-actions \{\s*opacity: 1;\s*pointer-events: auto;/u,
  );
  // The hold is this app's for its whole length, rather than shared with the
  // platform's text selection, and the row answers the finger while it runs.
  assert.match(
    css,
    /@media \(hover: none\) \{[\s\S]*?\.cmsg-row:not\(\.cmsg-system\),\s*\n\s*\.dm-msg \{[^}]*-webkit-touch-callout: none;[^}]*user-select: none;/u,
  );
  assert.match(
    css,
    /\.cmsg-row code,\s*\n\s*\.cmsg-row pre,[\s\S]*?user-select: text;/u,
  );
  assert.match(css, /\.cmsg-row\.msg-holding \{\s*\n\s*background: var\(--bg-hover\);/u);
  assert.match(css, /\.dm-msg\.msg-holding \.dm-bubble \{/u);
});

test("sending a message takes the command picker down with the draft", async () => {
  const chats = await publicFile("screen-chats.js");

  // Sending empties the composer, so the list of completions for the word
  // that was in it has nothing left to complete. It used to be left open:
  // only a keystroke reconsiders the pickers, so a `/` picker that was still
  // up at send hung over the emptied composer and followed the reader into
  // the next channel.
  const send = slice(
    chats,
    "export function submitComposerMessage(",
    "function pinnedBanner(",
  );
  assert.equal(
    send.match(/closeComposerAutocomplete\("channel"\)/gu)?.length,
    2,
    "both a channel message and a reply from the channel composer close it",
  );
  assert.doesNotMatch(
    send,
    /state\.mentionActive = false;/u,
    "no send path should half-close the pickers by hand",
  );
  assert.match(
    slice(
      chats,
      "export function submitThreadReply(",
      "function closeComposerAutocomplete(",
    ),
    /closeComposerAutocomplete\("thread"\)/u,
  );

  const source = slice(
    chats,
    "function closeComposerAutocomplete(",
    "function autocompleteSnapshot(",
  );
  const state = {
    composerAutocompleteTarget: "channel",
    mentionActive: true,
    mentionQuery: "ma",
    mentionIndex: 2,
    slashActive: true,
    slashQuery: "dep",
    slashIndex: 3,
  };
  const close = new Function(
    "state",
    `${source}\nreturn closeComposerAutocomplete;`,
  )(state) as (target: string) => void;

  // The composer that did not send keeps its half-typed word and its picker.
  close("thread");
  assert.equal(state.slashActive, true);

  // The query and the highlighted row go too, so the next `/` starts fresh.
  close("channel");
  assert.deepEqual(state, {
    composerAutocompleteTarget: "channel",
    mentionActive: false,
    mentionQuery: "",
    mentionIndex: 0,
    slashActive: false,
    slashQuery: "",
    slashIndex: 0,
  });
});

test("pinned messages stay available and open at their thread root", async () => {
  const [app, chats, data] = await Promise.all([
    publicFile("app.js"),
    publicFile("screen-chats.js"),
    publicFile("data.js"),
  ]);
  const action = slice(
    app,
    'case "channel-pinned-open":',
    'case "channel-pin-jump":',
  );
  assert.match(chats, /data-act="channel-pinned-open"/u);
  assert.match(action, /state\.activeChannelThread = value;/u);
  assert.match(action, /state\.scrollToThreadMessage = value;/u);
  // The thread joins the column rather than emptying it: a plan or a file
  // open beside it is usually why the pin was worth following.
  assert.doesNotMatch(action, /state\.activePlan = undefined;/u);
  assert.doesNotMatch(action, /channelPins/u);
  assert.doesNotMatch(action, /entry\.kind|entry\.replies|entry\.taskId/u);

  const restore = slice(
    chats,
    "export function restoreChannelScroll(",
    'const list = document.querySelector("#chan-messages")',
  );
  assert.match(restore, /messageId === root\s*\? "\.thread-root"/u);
  assert.match(restore, /scrollIntoView\(\{ block: "center" \}\)/u);

  const deletion = slice(
    data,
    "export async function deleteChannelMessageEntry(",
    "/**\n * Removes one whole thread",
  );
  assert.match(deletion, /if \(response\?\.redacted !== true\)/u);
});

test("a reaction is only offered where it can be saved, and is taken back when it is not", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // Reactions live on `channel_messages`. A reply is a row in another table
  // entirely, so `toggleChannelReaction` in the store throws for one, the
  // route answers 404 — and the optimistic emoji stayed on screen anyway,
  // claiming a reaction the server had no record of.
  //
  // Decided on `messageId`, the field that says what a row *is*, rather than
  // on the flag that says how it is drawn: the thread panel renders its own
  // root in the reply style, and that root is a channel message which can be
  // reacted to perfectly well.
  assert.match(chats, /const isReplyRow = entry\.messageId !== undefined;/u);
  const row = slice(chats, "  const reactions = Object.entries", "\n    <span class=\"cmsg-actions\">");
  assert.match(
    row,
    /deleted \|\| isReplyRow \|\| reactions\.length === 0/u,
    "the reaction tally should be drawn only where a reaction can be saved",
  );
  const actions = slice(chats, '    <span class="cmsg-actions">', "\n/**");
  assert.match(
    actions,
    /deleted \|\| isReplyRow\s*\n\s*\? ""\s*\n\s*: iconButton\("smile"/u,
    "the hover React button should be behind the same guard",
  );

  // And where a reaction *can* be sent, a refusal puts the tally back — the
  // same rollback `toggleChannelMessagePin` does, for the same reason: nothing
  // re-reads reactions until somebody else posts in the room.
  const toggle = slice(data, "export function toggleChannelReaction(", "\n/**");
  assert.match(toggle, /const before =\s*\n?\s*current === undefined/u);
  assert.match(toggle, /delete message\.reactions\[emoji\];/u);
  assert.match(toggle, /message\.reactions\[emoji\] = \{ \.\.\.before \};/u);
  assert.match(toggle, /rerender\?\.\(\);/u);
});

test("a message that did not send says so, and can be sent again", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const css = await publicFile("styles.css");

  // `sendChannelMessage` and `postChannelReply` have written this flag all
  // along and no renderer read it, so a message that never reached the server
  // looked exactly like one that had. The toast was the only evidence, and it
  // clears itself.
  assert.match(chats, /entry\.failed === true \? " cmsg-failed" : ""/u);
  assert.match(chats, /class="cmsg-failed-mark">\$\{icon\("alert"\)\} Not sent/u);
  assert.match(chats, /data-act="chan-message-resend"/u);
  assert.match(app, /case "chan-message-resend":/u);
  assert.match(app, /resendChannelMessage\(activeChannelId\(\), value, render\)/u);
  assert.match(css, /\.cmsg-failed-note \{/u);

  // The resend reuses the local id. The optimistic scheme assumes one POST per
  // id — `isServerChannelId` reads it to decide whether a reply may be
  // threaded on yet — so a second row would put two copies in the room.
  const resend = slice(data, "export function resendChannelMessage(", "\nfunction findChannelMessage(");
  assert.doesNotMatch(resend, /Date\.now\(\)/u, "a resend must not mint a new id");
  assert.match(resend, /entry\.failed = undefined;/u);
  assert.match(resend, /entry\.failed = true;/u, "a resend that fails again stays marked");
});

test("the command picker offers every command it has", async () => {
  const chats = await publicFile("screen-chats.js");
  const css = await publicFile("styles.css");

  // Ten commands and a cut at six meant `retry`, `cancel`, `stop` and `help`
  // were invisible on an empty query — which is the query the picker opens on
  // — including the one command whose whole job is to list the others.
  const candidates = slice(
    chats,
    "function channelSlashCandidates(",
    "\nfunction slashPopover(",
  );
  assert.doesNotMatch(candidates, /\.slice\(0, \d+\)/u);
  assert.match(candidates, /return matching;/u);
  // Ten rows is not a scale problem, because the list already scrolls: the
  // picker has been bounded by the viewport as well as by a ceiling since
  // before the cut was removed, so nothing about the layout had to change.
  assert.match(css, /max-height: min\(180px, 30vh\);\s*\n\s*overflow-y: auto;/u);
});

test("a sent private message is painted in the chosen accent", async () => {
  const app = await publicFile("app.js");
  const css = await publicFile("styles.css");

  // The outgoing bubble was a neutral surface, so the one place a person
  // looks to tell their own words from the other side's said nothing that
  // the greys around it did not already say.
  assert.match(css, /\.dm-mine \.dm-bubble \{\s*\n\s*background: var\(--accent\);/u);
  assert.match(css, /\.dm-mine \.dm-bubble \{[^}]*color: var\(--accent-ink\);/u);

  // Filled with the accent, the bubble needs an ink that is not the accent.
  // A hardcoded white would be unreadable on the yellows and limes the wheel
  // allows, so the theme picks whichever extreme actually reads on it.
  assert.match(app, /root\.setProperty\("--accent-ink", accentInk\(accent\)\);/u);
  const ink = slice(app, "function accentInk(", "\n}");
  assert.match(ink, /contrastRatio\("#ffffff", accent\) >= contrastRatio\("#141312", accent\)/u);
  // And a standing value in the stylesheet, for the frame before the theme
  // has been applied.
  assert.match(css, /--accent-ink: #141312;/u);
});

test("a private conversation stacks, and shows one message's time and delete at a time", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const css = await publicFile("styles.css");

  // A run from one person was a column of separate bubbles, each paying for
  // its own clock underneath. Consecutive messages from the same author now
  // close up, on the rule the room's transcript already follows.
  const grouping = slice(
    chats,
    "function continuesDirectMessageGroup(",
    "\n}",
  );
  assert.match(grouping, /startsNewDay \|\|/u);
  assert.match(grouping, /current\?\.referencedMessageId !== undefined/u);
  assert.match(grouping, /String\(previous\.authorId \?\? ""\) === authorId/u);

  const dmPanel = slice(chats, "function dmPanel()", "\nfunction threadPanel(");
  assert.match(dmPanel, /continuesDirectMessageGroup\(\s*messages\[index - 1\]/u);
  assert.match(dmPanel, /compact \? " dm-compact" : ""/u);
  assert.match(dmPanel, /message\.id === state\.dmSelectedMessageId/u);
  assert.match(dmPanel, /selected \? " dm-selected" : ""/u);

  // The choice is held in state, because the panel is rebuilt on every poll
  // and a class left on the row would not survive the next one.
  assert.match(data, /dmSelectedMessageId: undefined,/u);
  const select = slice(app, "function selectDirectMessage(", "\n}");
  // Only a pointer arrives here now: a finger holds the message instead, and
  // its taps are spent putting the last answer away.
  assert.match(select, /if \(isTouchInput\(event\)\) \{\s*\n\s*return;/u);
  assert.match(select, /row\.dataset\.dmMessage/u);
  assert.match(select, /chosen === state\.dmSelectedMessageId \? undefined : chosen/u);
  assert.match(select, /state\.dmSelectedMessageId = next;/u);
  // Revealing a message's controls must not replace its scroll container.
  // The selected id still survives future polls through state, while the
  // immediate interaction only updates the rows that are already in place.
  assert.match(select, /clearMessageHoldSelection\(\);/u);
  assert.match(select, /row\.classList\.add\("dm-selected"\)/u);
  const clear = slice(app, "function clearMessageHoldSelection(", "\n}");
  assert.match(clear, /document\.querySelectorAll\("\.dm-msg\.dm-selected"\)/u);
  assert.match(clear, /selected\.classList\.remove\("dm-selected"\)/u);
  assert.doesNotMatch(
    select,
    /\brender\(\)/u,
    "selecting a private message must not rebuild and reset its scroller",
  );
  // Only for a press that does nothing else, so a reply or a delete is not
  // re-rendered out from under its own click.
  assert.match(
    app,
    /if \(found === undefined\) \{[\s\S]*?selectDirectMessage\(event\);\s*\n\s*return;/u,
  );
  // And nothing stays selected once that conversation is gone.
  assert.match(data, /export function clearDirectMessageSelection\(\) \{/u);

  // Neither the clock nor the controls are laid out until they are asked
  // for — fading them would spend the height they cost anyway.
  assert.match(
    css,
    /\.dm-msg \.dm-time,\s*\n\.dm-msg \.dm-msg-actions \{\s*\n\s*display: none;/u,
  );
  assert.match(css, /\.dm-msg\.dm-selected \.dm-time,/u);
  assert.match(css, /\.dm-msg\.dm-selected \.dm-msg-actions,/u);
  assert.match(css, /\.dm-msg\.dm-compact \{\s*\n\s*margin-top: -6px;/u);
  // A finger gets the same one message's controls — by holding it — rather
  // than every message in the conversation carrying its bar at once.
  assert.doesNotMatch(
    css,
    /@media \(hover: none\) \{[\s\S]*?\.dm-msg \.dm-msg-actions \{\s*opacity: 1 !important;/u,
  );
});
