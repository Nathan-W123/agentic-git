import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultPublicDirectory } from "./assets.js";
import {
  ATTACHMENT_ID_PATTERN,
  AttachmentStore,
  AttachmentTypeError,
  attachmentContentType,
} from "./attachments.js";

/**
 * The allowlist is a security boundary, and this is the file that says what
 * moving it did and did not allow.
 *
 * A channel took pictures and nothing else, which meant the two things people
 * most often need to hand an agent — a zipped bundle of logs or sources, and
 * a specification written in Markdown — had to be pasted in as text or not
 * sent at all. Both are here now. What is emphatically not here is anything a
 * browser might render as a document on this origin: no SVG, no HTML, and a
 * `Content-Disposition: attachment` on everything that is not an image.
 */
async function store(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<AttachmentStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-attachments-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return new AttachmentStore(directory);
}

const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.alloc(26),
]);

test("a ZIP archive and a Markdown file are both storable", async (t) => {
  const attachments = await store(t);

  const zip = await attachments.save(ZIP, "application/zip");
  assert.match(zip, /^[0-9a-f]{32}\.zip$/u);
  const markdown = await attachments.save(
    Buffer.from("# Spec\n\n- one\n- two\n", "utf8"),
    "text/markdown",
  );
  assert.match(markdown, /^[0-9a-f]{32}\.md$/u);

  // Read back with a type this store derived from its own allowlist, never
  // from what the uploader claimed.
  assert.equal((await attachments.read(zip))?.contentType, "application/zip");
  assert.equal(
    (await attachments.read(markdown))?.contentType,
    "text/markdown",
  );
  // And reachable on disk, which is the whole of what an agent is given: it
  // cannot be shown an archive, only told where one is.
  assert.ok((await attachments.pathFor(zip)) !== undefined);
  assert.equal(await attachments.pathFor(`${"a".repeat(32)}.zip`), undefined);
});

test("what a browser calls a zip on Windows is still a zip", async (t) => {
  // `application/x-zip-compressed` is what a Windows browser sends for a
  // `.zip` picked from disk. Refusing it would mean the feature did not work
  // on a good share of the machines it is used from, and the bytes are
  // checked either way.
  const attachments = await store(t);
  assert.match(
    await attachments.save(ZIP, "application/x-zip-compressed"),
    /^[0-9a-f]{32}\.zip$/u,
  );
});

test("bytes that are not what they claim are refused", async (t) => {
  const attachments = await store(t);

  // A ZIP is a container with a fixed opening, so this is the same signature
  // check images have always had.
  await assert.rejects(
    attachments.save(Buffer.from("not an archive at all"), "application/zip"),
    AttachmentTypeError,
  );

  // Markdown has no signature — it is text, which is the thing with no fixed
  // opening — so what is checked is that it *is* text: decodable UTF-8 with
  // no control bytes in it. This is what stops an executable being stored as
  // a `.md` and served back from this origin.
  await assert.rejects(
    attachments.save(
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
      "text/markdown",
    ),
    AttachmentTypeError,
  );
  await assert.rejects(
    attachments.save(Buffer.from([0xff, 0xfe, 0xfd]), "text/markdown"),
    AttachmentTypeError,
  );

  // Still no SVG and still no HTML: both are documents that can carry script,
  // and this origin holds the session.
  await assert.rejects(
    attachments.save(Buffer.from("<svg onload=alert(1)>"), "image/svg+xml"),
    AttachmentTypeError,
  );
  await assert.rejects(
    attachments.save(Buffer.from("<h1>hello</h1>"), "text/html"),
    AttachmentTypeError,
  );
});

test("markdown keeps the whitespace that documents are made of", async (t) => {
  const attachments = await store(t);
  const document = Buffer.from(
    "﻿# Title\r\n\r\n\tindented\n\n| a | b |\n— em dash, é, 日本語\n",
    "utf8",
  );
  const id = await attachments.save(document, "text/markdown");
  assert.deepEqual((await attachments.read(id))?.bytes, document);
});

test("an id is only ever one of the shapes this store issues", () => {
  for (const extension of ["png", "jpg", "gif", "webp", "zip", "md"]) {
    assert.ok(ATTACHMENT_ID_PATTERN.test(`${"0".repeat(32)}.${extension}`));
    assert.ok(
      attachmentContentType(`${"0".repeat(32)}.${extension}`) !== undefined,
    );
  }
  // The read and path routes take an id back out of a URL, and a URL is the
  // one place a `..` gets in.
  for (const id of [
    "../../etc/passwd",
    `${"0".repeat(32)}.svg`,
    `${"0".repeat(32)}.exe`,
    `${"0".repeat(31)}.zip`,
    `${"0".repeat(32)}.zip/../secret`,
    "",
  ]) {
    assert.equal(ATTACHMENT_ID_PATTERN.test(id), false, id);
    assert.equal(attachmentContentType(id), undefined, id);
  }
});

test("the browser only offers what the store takes", async () => {
  const read = async (name: string): Promise<string> =>
    await readFile(path.join(defaultPublicDirectory(), name), "utf8");
  const [app, chats] = await Promise.all([read("app.js"), read("screen-chats.js")]);

  // The composer resolves the type from the file name for the two formats a
  // browser is unreliable about — Windows reports nothing at all for `.md` —
  // and the store still checks the bytes against whatever is claimed.
  assert.match(app, /function attachmentContentType\(file\)/u);
  assert.match(app, /name\.endsWith\("\.zip"\)/u);
  assert.match(app, /name\.endsWith\("\.md"\)/u);
  assert.match(app, /uploadAttachment\(repositoryId, file, contentType\)/u);

  // Every picker offers the same set, so nothing is choosable that would only
  // be refused after it had uploaded.
  const pickers = [...chats.matchAll(/accept="([^"]+)"/gu)].map(
    (match) => match[1] ?? "",
  );
  const attachPickers = pickers.filter((accept) => accept.includes("image/png"));
  assert.ok(attachPickers.length >= 3, "every composer should offer a picker");
  for (const accept of attachPickers) {
    assert.match(accept, /application\/zip/u);
    assert.match(accept, /text\/markdown/u);
    assert.doesNotMatch(accept, /svg/u);
  }

  // And a file that is not a picture is drawn as a named chip rather than as
  // an image tag that could only ever be broken.
  assert.match(chats, /function attachmentFileChip\(base, file\)/u);
  assert.match(chats, /files\.map\(\(file\) => attachmentFileChip\(base, file\)\)/u);
  assert.ok(
    chats.includes("attachment:([0-9a-f]{32}\\.(?:png|jpg|gif|webp|zip|md))"),
    "the transcript should read the same id shapes the store issues",
  );
});
