import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The browser half of sub-channels.
 *
 * A repository used to be a channel outright, and the one property that must
 * survive dividing it is that an undivided repository is unchanged: no
 * heading it did not have, the same URL, the same composer. Everything below
 * pins one of the places that could quietly stop being true.
 *
 * Pinned by the shape of the source, the way the rest of the browser surface
 * is: the dashboard ships as plain ES modules with no bundler, and the test
 * run has no DOM to render them into.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("every read and write says which room it means", async () => {
  const data = await publicFile("data.js");

  assert.match(data, /const scopedChannelPath = \(repositoryId, suffix/u);
  assert.match(data, /channelId=\$\{encodeURIComponent\(channelId\)\}/u);

  // The per-room surfaces. A message list, a post, a roster, a read cursor
  // and a typing ping all have to be scoped, or a second room shows the
  // first one's transcript and marks it read.
  for (const call of [
    /scopedChannelPath\(repositoryId, `\/messages\?limit=/u,
    /scopedChannelPath\(repositoryId, "\/messages"\)/u,
    /scopedChannelPath\(repositoryId, "\/agents"\)/u,
    /scopedChannelPath\(repositoryId, "\/read"\)/u,
    /scopedChannelPath\(repositoryId, "\/typing"\)/u,
  ]) {
    assert.match(data, call);
  }
});

test("an undivided repository keeps the interface it always had", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  // The heading and list only appear once there is a second room to pick, or
  // for somebody who can create one.
  assert.match(
    chats,
    /channels\.length > 1 \|\| canManageSubChannels\(activeRepositoryId\)/u,
  );
  // The composer names the room — including the only room. It used to fall
  // back to the workspace name here, which was the whole point of this test
  // until the header began naming the room and the two started disagreeing on
  // screen. What "unchanged" has to mean is that nothing appears that a reader
  // did not have before, not that the two halves of one sentence disagree.
  assert.doesNotMatch(chats, /Message #\$\{repositoryLabel\(repositoryId\)\}/u);
  assert.match(chats, /`Message \$\{subChannelLabel\(/u);
  // And the URL gains no query parameter it did not have.
  assert.match(app, /subChannelsFor\(workspaceId\)\.length > 1/u);
  assert.match(app, /query\.set\("channel", channelId\)/u);
});

test("a room somebody may read but not post in replaces the composer", async () => {
  const chats = await publicFile("screen-chats.js");

  assert.match(chats, /canPostInActiveSubChannel\(repositoryId\)/u);
  assert.match(chats, /chan-composer-locked/u);
  // Replaced, not disabled: the note has to say who may fix it.
  assert.match(chats, /Ask an admin to add you/u);

  const styles = await publicFile("styles.css");
  assert.match(styles, /\.chan-composer-locked \{/u);
});

test("only an administrator is offered the settings a room has", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");

  assert.match(chats, /export function subChannelManagePopoverHtml/u);
  assert.match(chats, /manage\s*\?\s*`<button type="button" class="icon-btn chan-channel-menu"/u);
  for (const act of [
    "sub-channel-rename",
    "sub-channel-visibility",
    "sub-channel-delete",
    "sub-channel-member-toggle",
  ]) {
    assert.ok(chats.includes(act), `${act} should be offered in the popover`);
    assert.ok(app.includes(`case "${act}"`), `${act} should be handled`);
  }
  // #general is the fallback room for every unaddressed message, so it is
  // not renamed, hidden or removed from here. Pinned by what the popover
  // actually says now: the old wording had been rewritten on screen and this
  // line went on asserting a sentence no reader had seen in a long while.
  assert.match(chats, /can read and post in #general/u);
});

test("the channel settings popover lists only in-room members with add and remove controls", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  // The list is built from the room's own membership, not from the whole
  // workspace with a word on the end of each row saying which half it was in.
  assert.match(chats, /export function subChannelMemberRowHtml/u);
  assert.match(chats, /export function subChannelAddablePeople/u);
  assert.doesNotMatch(chats, /sub-channel-member-state/u);

  // Adding runs through the same already-handled action as removing, in the
  // other direction — there is no second endpoint behind the "+".
  assert.match(chats, /export function subChannelMemberAddHtml/u);
  for (const direction of ["\\|out", "\\|in"]) {
    assert.match(
      chats,
      new RegExp(`sub-channel-member-toggle[\\s\\S]{0,220}${direction}`, "u"),
    );
  }

  // Both shapes of person record resolve through one pair of readers, so a
  // row cannot fall back to "Someone" on one list and a name on the other.
  assert.match(chats, /export function subChannelPersonId/u);
  assert.match(chats, /export function subChannelPersonName/u);

  // The "..." is revealed the way a roster row's is, rather than sitting lit
  // beside every name.
  assert.match(styles, /\.scm-more \{[\s\S]*?opacity: 0;/u);
  assert.match(styles, /\.sub-channel-member:hover \.scm-more/u);
});

test("a private room is drawn as private, and a typing ping stays in its room", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // A work channel's sigil is its branch, and a private one's is a lock. Both
  // in one expression, in that order, because a work channel that is also
  // private has to pick one and "this ships somewhere else" is the fact a
  // reader cannot get from the name — the lock's meaning is still spelled out
  // in words on the row and in the settings panel.
  assert.match(
    chats,
    /channel\.branch\s*\?\s*icon\("branch"\)\s*:\s*channel\.visibility === "private"\s*\?\s*icon\("lock"\)/u,
  );
  const noteTyping = data.slice(data.indexOf("export function noteTyping"));
  assert.match(
    noteTyping.slice(0, noteTyping.indexOf("\n}")),
    /frame\.channelId !== open/u,
  );
});

test("a channel can be opened as a branch, and says so everywhere it is shown", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const styles = await publicFile("styles.css");

  // Asked once, when the room is created. A branch cannot move afterwards
  // without orphaning every commit on it, so this is what the room is rather
  // than a setting it carries.
  assert.match(app, /function branchChoiceHtml\(\)/u);
  const newChannel = app.slice(app.indexOf('case "sub-channel-new"'));
  const dialog = newChannel.slice(0, newChannel.indexOf('case "sub-channel-menu"'));
  assert.match(dialog, /\$\{branchChoiceHtml\(\)\}/u);
  // The checkbox's `checked` boolean, not its `value` string — `showModal`
  // resolves the two differently and comparing against "on" would send
  // `false` for every ticked box.
  assert.match(dialog, /values\.branch === true/u);
  assert.match(styles, /\.chan-branch-choice \{/u);

  // Only sent when it was asked for, so an ordinary channel's request is
  // byte-for-byte what it was before work channels existed.
  const create = data.slice(data.indexOf("export async function createSubChannel"));
  assert.match(
    create.slice(0, create.indexOf("\n}")),
    /branch === true \? \{ branch: true \} : \{\}/u,
  );

  // And it is visible without opening anything: the row's own title says
  // which branch, so the sigil is not the only place the fact lives.
  assert.match(chats, /works on \$\{esc\(channel\.branch\)\}/u);
  // A merged channel reads as merged rather than as read-only. Both mean
  // "you cannot post here", and only one of them says why.
  assert.match(
    chats,
    /channel\.mergedAt\s*\n?\s*\?\s*`<span class="chan-channel-note"[\s\S]{0,400}>merged<\/span>`/u,
  );
  // The settings panel says it in a sentence, and withholds Rename — the
  // server refuses that for a work channel, and an affordance whose only
  // outcome is an error toast is worse than no affordance.
  const manage = chats.slice(chats.indexOf("export function subChannelManagePopoverHtml"));
  const panel = manage.slice(0, manage.indexOf("\nexport function", 1));
  assert.match(panel, /Work in this\s+channel lands on/u);
  assert.match(panel, /channel\.branch\s*\?\s*""\s*:\s*`<button[^`]*sub-channel-rename/u);
});

test("a work channel's branch is reviewed and merged from the room itself", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const styles = await publicFile("styles.css");

  // The way in sits with the room, not on a separate screen: the diff, the
  // conversation and the tasks that produced it are one thing.
  assert.match(chats, /act: "branch-review-open"/u);
  // And only where there is a branch. A button that opened an empty panel
  // would be worse than no button.
  assert.match(
    chats,
    /main && openSubChannel\(repositoryId\)\?\.branch\s*\n?\s*\?\s*iconButton\("branch"/u,
  );

  // It draws in the secondary column, beside the transcript, the way threads
  // and files already do — so reading the diff and reading what people said
  // about it happen side by side.
  assert.match(chats, /case "branch":\s*\n\s*return branchReviewPanel\(repositoryId\)/u);
  assert.match(app, /openSecondaryContext\("branch"\)/u);

  // The three states the panel has to tell apart, and does.
  assert.match(chats, /review\.merged === true/u);
  assert.match(chats, /\(review\.ahead \?\? 0\) === 0/u);
  assert.match(chats, /conflicts\.length > 0/u);
  // The merge button is drawn only for somebody the server would let merge,
  // and disabled while anything conflicts.
  assert.match(chats, /review\.canMerge === true/u);
  assert.match(chats, /busy \|\| conflicts\.length > 0 \? "disabled" : ""/u);
  assert.match(styles, /\.branch-panel \.fp-stats/u);

  // Merging closes the channel, so it is confirmed rather than a single
  // click, and the transcript is re-read for the line the server posts.
  const merge = app.slice(app.indexOf('case "branch-review-merge"'));
  const handler = merge.slice(0, merge.indexOf('case "secondary-context-close"'));
  assert.match(handler, /showModal\(/u);
  assert.match(handler, /mergeBranchReview\(repositoryId, value\)/u);
  assert.match(handler, /ensureChannelMessages\(repositoryId, render\)/u);

  // The review is not patched in from the write's response: a refresh or a
  // merge moves the branch, so every number in it is about a commit that no
  // longer exists.
  for (const name of ["refreshBranchReview", "mergeBranchReview"]) {
    const fn = data.slice(data.indexOf(`export async function ${name}`));
    assert.match(
      fn.slice(0, fn.indexOf("\n}")),
      /loadBranchReview\(repositoryId, channelId\)/u,
      name,
    );
  }
});

test("a merged channel offers the second gate, on GitHub", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // Only after the merge. Kumi reviews the branch into the repository, GitHub
  // reviews the repository into main — offering the second before the first
  // would ask a second set of reviewers for work Kumi has not accepted.
  const panel = chats.slice(chats.indexOf("function branchReviewBody"));
  const merged = panel.slice(0, panel.indexOf("\nfunction branchSummary"));
  assert.match(merged, /review\.merged === true/u);
  assert.match(merged, /act="branch-review-ship"/u);
  // Once shipped it links to the pull request rather than offering to open a
  // second one, and the button changes to what it now does.
  assert.match(merged, /review\.pullRequestUrl/u);
  assert.match(merged, /Update the pull request/u);
  assert.match(merged, /Open a pull request on GitHub/u);
  // And it is not drawn for somebody the server would refuse.
  assert.match(merged, /review\.canShip === true/u);

  // Not confirmed the way the merge is: this opens a pull request for people
  // to look at, closing one is how it is undone, and pressing twice reaches
  // the same one.
  const ship = app.slice(app.indexOf('case "branch-review-ship"'));
  const handler = ship.slice(0, ship.indexOf('case "secondary-context-close"'));
  assert.doesNotMatch(handler, /showModal\(/u);
  assert.match(handler, /shipBranchReview\(repositoryId, value\)/u);
  // A refusal is a real answer with a fixable reason, not a thrown error, so
  // its explanation is what reaches the person.
  assert.match(handler, /outcome\?\.outcome === "done"/u);
  assert.match(handler, /outcome\.explanation/u);

  // The link lives on the channel, so the channel list is re-read rather than
  // the response patched in.
  const fn = data.slice(data.indexOf("export async function shipBranchReview"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /loadSubChannels\(repositoryId\)/u);
  assert.match(body, /loadBranchReview\(repositoryId, channelId\)/u);
});

test("switching rooms clears every cache it names, and cannot half-finish", async () => {
  const data = await publicFile("data.js");

  // Run the real function rather than read it. This file pins the browser by
  // the shape of its source, which is right for markup — and is exactly what
  // let this one ship: `selectSubChannel` deleted `state.channelPinned`, and
  // the state it meant is `channelPins`. Every regex here passed while
  // `delete undefined[repositoryId]` threw in the browser.
  //
  // The throw was costly out of proportion to the pins it dropped. It came
  // after four caches were already cleared and before
  // `channelLoaded.delete`, so the transcript read as loaded and empty and
  // nothing refetched it; `sub-channel-open` never reached its `render()`, so
  // a room click did nothing; and `createSubChannel`, which calls this last,
  // reported failure for a channel the server had already created.
  const start = data.indexOf("export function selectSubChannel");
  assert.notEqual(start, -1, "selectSubChannel was not found");
  const body = data
    .slice(start, data.indexOf("\n}", start) + 2)
    .replace("export function", "function");

  const state = {
    activeSubChannel: {} as Record<string, string>,
    channelMessages: { repo: ["stale"] } as Record<string, unknown>,
    channelEarlier: { repo: 1 } as Record<string, unknown>,
    channelHasMore: { repo: true } as Record<string, unknown>,
    channelFailed: { repo: "boom" } as Record<string, unknown>,
    channelPins: { repo: ["pinned"] } as Record<string, unknown>,
    channelLoaded: new Set(["repo"]),
    channelRosterLoaded: new Set(["repo"]),
  };
  // Injected, because `selectSubChannel` now clears the room's unread badge on
  // the way in. Recorded rather than stubbed away: opening a room is reading
  // it, and a switch that forgot to say so would leave a badge on the room the
  // reader is looking at.
  const cleared: string[] = [];
  const selectSubChannel = new Function(
    "state",
    "noteSubChannelRead",
    `${body}; return selectSubChannel;`,
  )(state, (repositoryId: string, channelId: string) =>
    cleared.push(`${repositoryId}/${channelId}`),
  ) as (repositoryId: string, channelId: string) => void;

  selectSubChannel("repo", "chan_backend");

  assert.equal(state.activeSubChannel["repo"], "chan_backend");
  for (const key of [
    "channelMessages",
    "channelEarlier",
    "channelHasMore",
    "channelFailed",
    "channelPins",
  ] as const) {
    assert.equal(
      state[key]["repo"],
      undefined,
      `${key} still holds the previous room's data`,
    );
  }
  // The one that matters most: left set, the new room reads as already
  // loaded and its transcript never arrives.
  assert.equal(state.channelLoaded.has("repo"), false);
  assert.equal(state.channelRosterLoaded.has("repo"), false);
  assert.deepEqual(cleared, ["repo/chan_backend"]);

  // Every name it clears has to be somewhere `state` actually declares.
  const names = /for \(const key of \[([\s\S]*?)\]\)/u.exec(data.slice(start));
  assert.ok(names !== null, "the cleared-cache list was not found");
  for (const quoted of (names[1] ?? "").match(/"[a-zA-Z]+"/gu) ?? []) {
    const key = quoted.slice(1, -1);
    assert.match(
      data,
      new RegExp(`^  ${key}: `, "mu"),
      `selectSubChannel clears ${key}, which state never declares`,
    );
  }
});
