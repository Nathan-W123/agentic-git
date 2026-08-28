import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a newly connected agent defaults into every current repository", async () => {
  const data = await publicFile("data.js");
  const agents = await publicFile("screen-agents.js");

  assert.match(data, /export async function addAgentToAllRepositories/u);
  assert.match(data, /state\.repositories\.map/u);
  assert.match(data, /\/membership`[\s\S]{0,100}method: "POST"/u);

  // Browser sign-in can finish while the dialog is open or after its confirm
  // button; the pasted-credential path is the third successful connection.
  assert.equal(
    agents.match(/await addAgentToAllRepositories\(providerId\)/gu)?.length,
    3,
  );
});

test("every connected agent defaults into repositories made later", async () => {
  const data = await publicFile("data.js");
  const repositories = await publicFile("screen-repos.js");

  assert.match(data, /export async function addConnectedAgentsToRepository/u);
  assert.match(data, /agent\.mine === true && agent\.connected/u);
  assert.equal(
    repositories.match(/await addConnectedAgentsToRepository\(/gu)?.length,
    2,
    "creation and GitHub import should apply the same default",
  );
});

test("the default does not remove the per-repository controls", async () => {
  const data = await publicFile("data.js");
  assert.match(data, /export function addChannelAgent/u);
  assert.match(data, /export function removeChannelAgent/u);
  assert.match(data, /method: "DELETE"/u);
});

test("an agent is added to the room that is open, not to the repository", async () => {
  const data = await publicFile("data.js");

  // Membership became per sub-channel, so the add has to name one. It goes
  // through `scopedChannelPath`, which appends whichever room is open — and
  // `#general` when the browser has not been told there is another.
  assert.match(
    data,
    /scopedChannelPath\(\s*repositoryId,\s*`\/agents\/\$\{encodeURIComponent\(agentId\)\}\/membership`,?\s*\)/u,
  );

  // The connect-time default stays repository-wide on purpose: a new
  // connection belongs in every workspace's #general, which is what the
  // unscoped path means to the server.
  assert.match(data, /export async function addAgentToAllRepositories/u);
  assert.match(
    data,
    /channelPath\(\s*repositoryId,\s*`\/agents\/\$\{encodeURIComponent\(providerId\)\}\/membership`,?\s*\)/u,
  );
});
