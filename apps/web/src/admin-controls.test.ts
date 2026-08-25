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
 * somebody was either absent or reachable only through the API, and
 * renaming or deleting a repository had no control at all — the menu that
 * carried deletion was anchored to a repositories grid this interface stopped
 * rendering, so nothing on screen opened it.
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

test("the People row's menu offers role, co-owner and KUMI controls", async () => {
  const chats = await publicFile("screen-chats.js");
  const menu = slice(
    chats,
    "export function personMenuItems(userId)",
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

test("a channel offers renaming and deleting its repository", async () => {
  const chats = await publicFile("screen-chats.js");
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // The menu is anchored to the channel header, which is what makes it
  // reachable: nothing else on screen opens it.
  assert.match(chats, /act: "channel-menu"/u);

  const menu = slice(app, 'case "channel-menu":', 'case "channel-agent-menu"');
  assert.match(menu, /act: "channel-rename-repo"/u);
  assert.match(menu, /act: "channel-delete-repo"/u);
  assert.match(menu, /canManageRepository\(value\)/u);
  assert.match(menu, /canDeleteRepository\(value\)/u);

  assert.match(app, /async function renameRepositoryAction\(repositoryId\)/u);
  assert.match(app, /case "channel-rename-repo":/u);

  // Renaming changes what the repository is called and nothing else: the id
  // keeps addressing the channel, its tasks and its files.
  assert.match(data, /export async function renameRepository\(repositoryId, name\)/u);
  assert.match(data, /method: "PATCH",\n {4}body: \{ name: trimmed \}/u);
  assert.match(data, /export function repositoryLabel\(repositoryId\)/u);
  assert.match(chats, /repositoryLabel\(repositoryId \?\? ""\)/u);
});

test("the channel menu offers delete repository only to owners and co-owners", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");

  // Renaming and deleting are gated separately now: an administrator, or the
  // person who created the repository, may still rename it, but deleting it
  // asks for ownership — the organization's owner, or a co-owner holding an
  // `owner` grant on this repository.
  const menu = slice(app, 'case "channel-menu":', 'case "channel-agent-menu"');
  const rename = slice(menu, 'canManageRepository(value)', 'canDeleteRepository(value)');
  assert.doesNotMatch(rename, /act: "channel-delete-repo"/u);
  const remove = slice(menu, 'canDeleteRepository(value)', ']);');
  assert.match(remove, /act: "channel-delete-repo"/u);
  assert.doesNotMatch(remove, /act: "channel-rename-repo"/u);

  // The same rule in the repository menu and in the channel-info popover.
  const repoMenu = slice(app, 'case "repo-menu":', 'case "repo-sync":');
  assert.match(repoMenu, /canDeleteRepository\(value\)/u);
  const popover = slice(
    chats,
    "export function channelInfoPopoverHtml(repositoryId)",
    "renderChats",
  );
  assert.match(popover, /const canDelete = canDeleteRepository\(repositoryId\)/u);
  assert.match(popover, /canDelete\s*\n\s*\? `<button[^`]*channel-delete-repo/u);

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
    /if \(agent\.mine === true\) \{\s*items\.push\(\{\s*act: "channel-agent-remove"/u,
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
