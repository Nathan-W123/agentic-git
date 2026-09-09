import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";

/**
 * The third way a workspace comes into being.
 *
 * There were two: create an empty repository, or import one from GitHub —
 * which between them miss the project that exists only on the laptop in front
 * of you and has never been pushed anywhere. So the folder itself travels: it
 * is zipped in the browser, posted as bytes, and unpacked into the same local
 * import the CLI has always had, `.git` and all.
 *
 * The dashboard ships as plain ES modules with no bundler and no DOM in the
 * test run, so the shape of the source is what there is to check.
 */
async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

test("a folder can be picked, and a zip of one for the browsers that cannot", async () => {
  const repos = await publicFile("screen-repos.js");
  const upload = repos.slice(repos.indexOf("export async function uploadRepository("));
  assert.notEqual(upload, "", "the copy-from-this-computer flow should exist");

  // A folder picker first, because "choose your project folder" is the whole
  // feature, and a `.zip` beside it for a browser without one.
  assert.match(upload, /name="folder" webkitdirectory/u);
  assert.match(upload, /name="archive"\s*\n?\s*accept="\.zip,application\/zip/u);
  // Both are read from the dialog, which is why `showModal` had to learn that
  // a file input's value is its files and not its fake path.
  assert.match(upload, /values\.archive/u);
  assert.match(upload, /values\.folder/u);

  const ui = await publicFile("ui.js");
  assert.match(ui, /field\.type === "file"/u);
  assert.match(ui, /values\[field\.name\] = \[\.\.\.\(field\.files \?\? \[\]\)\]/u);
});

test("the browser writes a real ZIP, entry by entry", async () => {
  const repos = await publicFile("screen-repos.js");
  // Local header, central directory, end record — the three signatures a ZIP
  // is made of. Written here rather than pulled in, because the reader on the
  // other end is ours too and a dependency for this is a supply chain in
  // exchange for a checksum.
  assert.match(repos, /0x04034b50/u);
  assert.match(repos, /0x02014b50/u);
  assert.match(repos, /0x06054b50/u);
  assert.match(repos, /function crc32\(bytes\)/u);
  // Names are UTF-8 and say so, which is the flag the reader trusts.
  assert.match(repos, /setUint16\(6, 0x0800, true\)/u);
  // Compressed where the browser can, stored where it cannot: an old browser
  // uploading three times as much is still an upload.
  assert.match(repos, /CompressionStream/u);
  assert.match(repos, /deflate-raw/u);
  // The path inside the folder, not the bare file name — a flat archive would
  // lose the tree.
  assert.match(repos, /file\.webkitRelativePath \|\| file\.name/u);
});

test("an oversized folder is turned away before it is uploaded", async () => {
  const repos = await publicFile("screen-repos.js");
  assert.match(repos, /const MAX_REPOSITORY_ARCHIVE_BYTES = 200 \* 1024 \* 1024;/u);
  assert.match(repos, /total > MAX_REPOSITORY_ARCHIVE_BYTES/u);
  // And says what to do instead, rather than only that it will not.
  assert.match(repos, /Push it to GitHub and import it from there instead/u);
});

test("the upload reaches its own route, with the name and branch beside it", async () => {
  const data = await publicFile("data.js");
  const upload = data.slice(
    data.indexOf("export async function uploadRepositoryArchive("),
  );
  assert.notEqual(upload, "", "the upload call should exist");
  // Bytes as the body, like an attachment: there is one file, and a form
  // encoding would only add a parser between the upload and the disk. The two
  // things the archive cannot carry ride in the query string.
  assert.match(upload, /repositories\/upload/u);
  assert.match(upload, /contentType: "application\/zip"/u);
  assert.match(upload, /query\.set\("id", id\)/u);
  assert.match(upload, /query\.set\("branch", branch\)/u);
});

test("all three ways to add a workspace are offered together", async () => {
  const app = await publicFile("app.js");
  const chats = await publicFile("screen-chats.js");

  assert.match(app, /case "repo-upload":\s*void uploadRepository\(render\);/u);
  const menu = app.slice(
    app.indexOf('case "channel-new":'),
    app.indexOf('case "channel-open":'),
  );
  assert.match(menu, /act: "repo-create"/u);
  assert.match(menu, /act: "repo-connect"/u);
  assert.match(menu, /act: "repo-upload"/u);
  // And on the screen somebody lands on with no workspaces at all, which is
  // exactly when a folder on their machine is the only repository they have.
  const empty = chats.slice(
    chats.indexOf("export function renderChats()"),
    chats.indexOf("export function renderChats()") + 1200,
  );
  assert.match(empty, /data-act="repo-upload"[\s\S]*Copy from this computer/u);
});
