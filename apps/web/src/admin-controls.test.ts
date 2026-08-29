import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The administrative controls a channel is expected to carry, pinned the way
 * the rest of the browser surface is pinned: by asserting the shape of the
 * source, since the dashboard ships as plain ES modules with no bundler and
 * the test run has no DOM.
 *
 * Two things a person could not previously do. Changing roles and removing
 * somebody was either absent or reachable only through the API, and deleting
 * a repository had no control at all — the menu that carried deletion was
 * anchored to a repositories grid this interface stopped rendering, so
 * nothing on screen opened it. Deletion hangs off the channel header's own
 * menu now, built by the same helper and behind the same owner gate.
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

test("the person details panel offers role, co-owner and KUMI controls", async () => {
  const chats = await publicFile("screen-chats.js");
  const menu = slice(
    chats,
    "export function personManagementItems(userId)",
    "const AUDITOR_ROLE",
  );

  // Repository-scoped, for whoever can moderate this repository.
  assert.match(menu, /act: "channel-grant-promote"/u);
  assert.match(menu, /label: "Promote to co-owner"/u);
  assert.match(menu, /act: "channel-grant-revoke"/u);
  assert.match(menu, /label: "Demote from co-owner"/u);

  // Organization-wide, and only for an admin or owner: these change what
  // somebody can reach in every repository, not just this one.
  assert.match(menu, /canManageOrganization\(\)/u);
  assert.match(menu, /act: "member-role"/u);
  assert.match(menu, /label: "Change role"/u);
  assert.match(menu, /act: "member-remove"/u);
  assert.match(menu, /label: "Remove from KUMI"/u);

  // Never on your own row, and never for somebody with no membership to
  // change — an item that always fails is worse than no item.
  assert.match(menu, /userId === currentUserId\(\)/u);
  assert.match(menu, /const role = memberRole\(userId\);/u);
  assert.match(menu, /role === undefined && canManageChannel/u);
});

test("change role and remove use the member routes", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  assert.match(app, /case "member-role":/u);
  assert.match(app, /case "member-remove":/u);
  assert.match(app, /async function memberRoleAction\(repositoryId, userId\)/u);
  assert.match(app, /async function removeMemberAction\(repositoryId, userId\)/u);

  // The dialog offers every ordinary organization role. Co-owner remains the
  // separate repository-scoped operation asserted above.
  const roleAction = slice(
    app,
    "async function memberRoleAction(repositoryId, userId)",
    "async function removeMemberAction",
  );
  assert.match(roleAction, /await showModal\(/u);
  assert.match(roleAction, /INVITE_ROLES\.map/u);
  assert.match(roleAction, /await updateMemberRole\(userId, role\)/u);
  assert.match(roleAction, /await setRepositoryGrant\(repositoryId, userId, role\)/u);
  for (const role of ["admin", "developer", "viewer"]) {
    assert.match(data, new RegExp(`value: "${role}"`, "u"));
  }

  const removeAction = slice(
    app,
    "async function removeMemberAction(repositoryId, userId)",
    "async function promoteRepositoryOwnerAction",
  );
  assert.match(removeAction, /Remove from KUMI/u);
  assert.match(removeAction, /await removeMember\(userId\)/u);
  assert.match(removeAction, /await revokeRepositoryGrant\(repositoryId, userId\)/u);

  assert.match(data, /export async function updateMemberRole\(userId, role\)/u);
  assert.match(data, /export async function removeMember\(userId\)/u);
  assert.match(data, /method: "PATCH", body: \{ role \}/u);
});

test("a repository owner grant changes the People-row title", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const row = slice(chats, "function personRow(person)", "/**\n * What the");

  assert.match(row, /grant\.userId === userId && grant\.role === "owner"/u);
  assert.match(row, /coOwner \? "Co-owner"/u);
  assert.match(
    app,
    /await setRepositoryGrant\(repositoryId, userId, "developer"\)/u,
  );
});

test("the channel menu offers owner-gated repository deletion", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const ui = await publicFile("ui.js");

  // The menu is anchored to the channel header, which is what makes it
  // reachable: nothing else on screen opens it.
  assert.match(chats, /act: "channel-menu"/u);

  const items = slice(app, "function conversationMenuItems(repositoryId)", "async function copyConversationLink");
  assert.match(items, /label: "Channel details"/u);
  assert.match(items, /label: "Copy link"/u);
  assert.match(items, /label: "Repository"/u);
  assert.match(items, /label: "Sync from GitHub"/u);
  assert.doesNotMatch(items, /separator: true/u);
  // Deleting comes last, from the shared helper — so the channel header and
  // the repository card cannot drift into offering it to different people.
  assert.match(items, /\.\.\.repositoryMenuItems\(repositoryId\)/u);
  // Renaming and leaving stay out of it: destruction is what had no surface.
  assert.doesNotMatch(items, /channel-rename-repo|channel-leave/u);

  const shared = slice(
    app,
    "function repositoryMenuItems(repositoryId)",
    "function conversationMenuItems(repositoryId)",
  );
  assert.match(shared, /if \(!canDeleteRepository\(repositoryId\)\) \{\s*return \[\];/u);
  assert.match(shared, /act: "channel-delete-repo"/u);
  assert.match(shared, /label: "Delete repository"/u);
  assert.match(shared, /danger: true/u);
  assert.doesNotMatch(shared, /separator: true/u);

  // Danger changes the row's colour, but does not silently insert a divider
  // between Sync from GitHub and Delete repository.
  const menu = slice(
    ui,
    "export function showMenu(anchor, items",
    "export function closePopover",
  );
  assert.match(menu, /const body = items\s*\.map/u);
  assert.match(menu, /item\.separator === true\s*\? `<div class="menu-sep"/u);
  assert.doesNotMatch(menu, /normalized|previous\?\.separator/u);

  // And the row reaches the action that asks for the typed phrase.
  assert.match(
    app,
    /case "channel-delete-repo":\s*void deleteRepositoryAction\(value\);/u,
  );
});

test("the agent surfaces name a renamed channel by its new name", async () => {
  const chats = await publicFile("screen-chats.js");

  // The channel agent panel names the repository through the shared label
  // helper: the pill beside the status, both halves of the Activity line,
  // and every pill in the Channels list.
  const spec = slice(chats, "function agentSpec(agent, repositoryId)", "function agentPanel()");
  assert.match(spec, /specPill\(`#\$\{repositoryLabel\(repositoryId\)\}`/u);
  assert.match(spec, /Nothing running in #\$\{esc\(repositoryLabel\(repositoryId\)\)\}/u);
  assert.match(spec, /repositoryLabel\(taskRepositoryId\)/u);
  assert.match(spec, /specPill\(`#\$\{repositoryLabel\(repository\.id\)\}`/u);

  // The catch-up digest read a `name` field no repository carries, so it
  // always fell back to the id however the channel had been renamed.
  const digest = slice(chats, "function catchUpPanel()", "function chanTreeNode");
  assert.match(digest, /repositoryLabel\(catchUp\.repositoryId\)/u);
  assert.doesNotMatch(digest, /repository\?\.name/u);
});

test("repository deletion stays owner-gated outside channel information", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // The repository card's menu builds its destructive row from the same
  // gated helper; the read-only channel information panel deliberately
  // carries no destructive control at all.
  const repoMenu = slice(app, 'case "repo-menu":', 'case "repo-sync":');
  assert.match(repoMenu, /\.\.\.repositoryMenuItems\(value\)/u);
  const popover = slice(
    chats,
    "export function channelInfoPopoverHtml(repositoryId)",
    "renderChats",
  );
  assert.doesNotMatch(popover, /channel-delete-repo|channel-leave/u);

  // The helper itself: an organization owner, or an `owner` grant on this
  // exact repository. Admins and the creator are deliberately not enough.
  const guard = slice(
    data,
    "export function canDeleteRepository(repositoryId)",
    "/**",
  );
  assert.match(guard, /currentOrganizationRole\(\) === "owner"/u);
  assert.match(guard, /currentRepositoryGrantRole\(repositoryId\) === "owner"/u);
  assert.doesNotMatch(guard, /createdBy/u);

  // Those grants have to be read for everyone, or a co-owner — whose only
  // claim is the grant — would never be offered the control.
  const ensure = slice(
    data,
    "export async function ensureRepositoryGrants(repositoryId, rerender)",
    "/**",
  );
  assert.doesNotMatch(ensure, /canManageRepository/u);
});

test("deleting a repository requires typing the confirmation phrase", async () => {
  const app = await publicFile("app.js");

  const action = slice(
    app,
    "async function deleteRepositoryAction(repositoryId)",
    "async function renameRepositoryAction(repositoryId)",
  );
  // The phrase is whatever the repository is called on screen — a renamed
  // repository asks for its new name — so it cannot be typed out of habit for
  // the wrong repository.
  assert.match(action, /const label = repositoryLabel\(repositoryId\);/u);
  assert.match(action, /const phrase = `yesiwanttodelete\$\{label\.replace\(/u);
  assert.match(action, /name="confirmation"/u);
  // Mismatched input says so and stops — the request is never sent.
  assert.match(
    action,
    /values\.confirmation[\s\S]*!==[\s\S]*phrase\.toLowerCase\(\)[\s\S]*?return;/u,
  );
  const sent = action.indexOf("await deleteRepository(repositoryId)");
  const checked = action.indexOf("values.confirmation");
  assert.notEqual(sent, -1);
  assert.notEqual(checked, -1);
  assert.ok(checked < sent, "the phrase is checked before the delete is sent");
});

test("agent identity and membership controls belong only to its owner", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");
  const menu = slice(
    chats,
    "export function rosterMenuItems(agentId)",
    "function chanSidebar",
  );

  assert.match(
    menu,
    /if \(agent\.mine === true\) \{\s*items\.push\(\{\s*act: "channel-settings-toggle"/u,
  );
  assert.match(
    menu,
    /if \(agent\.mine === true\) \{[\s\S]*?items\.push\(\{ separator: true \}\);[\s\S]*?act: "channel-agent-remove"/u,
  );
  assert.doesNotMatch(menu, /channel-agent-remove-any/u);

  const removal = slice(
    app,
    "async function removeChannelAgentAction(agentId)",
    "async function leaveRepositoryAction",
  );
  assert.match(removal, /agent\?\.mine !== true/u);
  assert.doesNotMatch(removal, /removeAny|removeChannelAgentForUser/u);
  assert.doesNotMatch(data, /removeChannelAgentForUser/u);
});
