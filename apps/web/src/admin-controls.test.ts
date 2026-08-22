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
 * Two things a person could not previously do. Promoting, demoting and
 * removing somebody was either absent or reachable only through the API, and
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

test("the People row's menu offers promote, demote and remove", async () => {
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
  assert.match(menu, /act: "member-promote"/u);
  assert.match(menu, /act: "member-demote"/u);
  assert.match(menu, /act: "member-remove"/u);

  // Never on your own row, and never for somebody with no membership to
  // change — an item that always fails is worse than no item.
  assert.match(menu, /userId === currentUserId\(\)/u);
  assert.match(menu, /const role = memberRole\(userId\);/u);
});

test("promote, demote and remove confirm and then call the member routes", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  assert.match(app, /case "member-promote":/u);
  assert.match(app, /case "member-demote":/u);
  assert.match(app, /case "member-remove":/u);
  assert.match(app, /async function memberRoleAction\(userId, role\)/u);
  assert.match(app, /async function removeMemberAction\(userId\)/u);

  // Both ask first. A role change reaches every repository the organization
  // owns, and a removal cannot be undone from this screen.
  const roleAction = slice(
    app,
    "async function memberRoleAction(userId, role)",
    "async function removeMemberAction",
  );
  assert.match(roleAction, /await showModal\(/u);
  assert.match(roleAction, /await updateMemberRole\(userId, role\)/u);

  assert.match(data, /export async function updateMemberRole\(userId, role\)/u);
  assert.match(data, /export async function removeMember\(userId\)/u);
  assert.match(data, /method: "PATCH", body: \{ role \}/u);
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

  assert.match(app, /async function renameRepositoryAction\(repositoryId\)/u);
  assert.match(app, /case "channel-rename-repo":/u);

  // Renaming changes what the repository is called and nothing else: the id
  // keeps addressing the channel, its tasks and its files.
  assert.match(data, /export async function renameRepository\(repositoryId, name\)/u);
  assert.match(data, /method: "PATCH",\n {4}body: \{ name: trimmed \}/u);
  assert.match(data, /export function repositoryLabel\(repositoryId\)/u);
  assert.match(chats, /repositoryLabel\(repositoryId \?\? ""\)/u);
});
