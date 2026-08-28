import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The workspace picture, which is the workspace's and not the reader's.
 *
 * It lived in `localStorage` — so the person who set one saw it and every
 * colleague saw the fallback initials, on a picture whose only purpose is
 * being the thing colleagues recognise the room by. These pin the two halves
 * of the fix: it is read off the shared repository record, and it is written
 * only by somebody who administers the workspace.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("the picture is read off the repository, not out of this browser", async () => {
  const data = await publicFile("data.js");

  // Run the real function. Reading the source would let a `channelPicture`
  // that still preferred `localStorage` pass on the strength of merely
  // *mentioning* `state.repositories`, and preferring the wrong one of the
  // two is the entire bug.
  const keyStart = data.indexOf("const legacyChannelPictureKey");
  const start = data.indexOf("export function channelPicture");
  assert.notEqual(keyStart, -1, "legacyChannelPictureKey was not found");
  assert.notEqual(start, -1, "channelPicture was not found");
  const source = `${data.slice(keyStart, data.indexOf("\n\n", keyStart))}
${data.slice(start, data.indexOf("\n}", start) + 2).replace("export function", "function")}`;

  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
  };
  const state = {
    repositories: [
      { id: "shared", picture: "data:image/jpeg;base64,SHARED" },
      { id: "unset" },
    ] as { id: string; picture?: string }[],
  };
  const channelPicture = new Function(
    "state",
    "localStorage",
    `${source}; return channelPicture;`,
  )(state, localStorage) as (repositoryId: string) => string | undefined;

  // What every colleague sees: the picture on the record, which arrives with
  // the repositories list whether or not this browser has ever set one.
  assert.equal(channelPicture("shared"), "data:image/jpeg;base64,SHARED");
  assert.equal(channelPicture("unset"), undefined);
  assert.equal(channelPicture("absent"), undefined);

  // A local copy from before the move is a fallback for a workspace with no
  // shared picture, and loses to one that has it. Were the order the other
  // way round, whoever set a picture in the old build would go on seeing
  // their own in place of the workspace's, and never know.
  store.set("ag.channelPicture.shared", "data:image/jpeg;base64,MINE");
  store.set("ag.channelPicture.unset", "data:image/jpeg;base64,MINE");
  assert.equal(channelPicture("shared"), "data:image/jpeg;base64,SHARED");
  assert.equal(channelPicture("unset"), "data:image/jpeg;base64,MINE");

  // An empty stored value is no picture, not a picture of nothing.
  state.repositories[0]!.picture = "";
  store.delete("ag.channelPicture.shared");
  assert.equal(channelPicture("shared"), undefined);
});

test("setting a picture goes to the server, and only an admin is offered it", async () => {
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  // The write is a request, not a `localStorage.setItem` — the only way a
  // colleague ever sees it.
  assert.match(data, /export async function setChannelPicture/u);
  assert.match(data, /repositoryPath\(repositoryId, "\/picture"\)/u);
  assert.match(data, /method: "PUT"/u);
  // And the browser's own copy goes, so it can never disagree with the record.
  assert.match(
    data,
    /localStorage\.removeItem\(legacyChannelPictureKey\(repositoryId\)\)/u,
  );

  // Offered to an administrator, and checked again where it is acted on:
  // hiding a control says what is offered, not what is permitted.
  assert.match(chats, /canManageRepository\(repo\.id\)\s*\?\s*`<label class="channel-rail-edit"/u);
  const handler = app.slice(app.indexOf("async function pickChannelPictureFile"));
  assert.match(
    handler.slice(0, handler.indexOf("\n}\n")),
    /if \(!canManageRepository\(repositoryId\)\) \{/u,
  );
});
