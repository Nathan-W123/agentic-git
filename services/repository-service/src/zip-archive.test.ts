import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import {
  extractZipArchive,
  readZipEntries,
  singleRootDirectory,
  zipEntryTargetPath,
  ZipArchiveError,
} from "./zip-archive.js";

/**
 * Reading a ZIP is the whole of "copy this folder into Kumi", so what is
 * tested here is the reader and not the feature: what it accepts, what it
 * refuses, and — most of all — that an archive naming a path outside the
 * directory it is being unpacked into never writes there.
 *
 * The fixtures are built rather than committed. A binary fixture in the tree
 * is a thing nobody can read in a review, and the writer below is thirty
 * lines of the same format the reader parses.
 */
interface Entry {
  name: string;
  bytes?: Buffer;
  /** Stored rather than deflated, which is what a folder of tiny files gets. */
  store?: boolean;
  /** A Unix mode, for the entries where the point is the mode. */
  mode?: number;
}

function buildZip(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.bytes ?? Buffer.alloc(0);
    const deflated = entry.store !== true && raw.length > 0;
    const body = deflated ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw) >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    // The high byte of "version made by" is the platform: 3 is Unix, which is
    // the only case where the external attributes carry a file mode.
    head.writeUInt16LE((((entry.mode === undefined ? 0 : 3) << 8) | 20) >>> 0, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(deflated ? 8 : 0, 10);
    head.writeUInt32LE(crc32(raw) >>> 0, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((((entry.mode ?? 0) & 0xffff) << 16) >>> 0), 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

async function temporaryDirectory(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coord-zip-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("a zipped folder unpacks as the folder it was", async (t) => {
  const archive = buildZip([
    { name: "project/", store: true },
    { name: "project/README.md", bytes: Buffer.from("# hello\n".repeat(40)) },
    { name: "project/src/run.sh", bytes: Buffer.from("#!/bin/sh\n"), mode: 0o100755 },
    // The reason this feature exists: a folder somebody has been working in
    // carries its history, and the history is a directory of small files.
    { name: "project/.git/HEAD", bytes: Buffer.from("ref: refs/heads/work\n"), store: true },
  ]);

  const entries = readZipEntries(archive);
  assert.equal(entries.length, 4);
  assert.equal(entries[0]?.isDirectory, true);
  // Both methods, because a real archive holds both: a writer stores what will
  // not compress and deflates what will.
  assert.equal(entries[1]?.compressionMethod, 8);
  assert.equal(entries[3]?.compressionMethod, 0);
  assert.equal(singleRootDirectory(entries), "project");

  const directory = await temporaryDirectory(t);
  const unpacked = await extractZipArchive(archive, directory);
  assert.equal(unpacked.files, 3);
  assert.equal(
    await readFile(path.join(directory, "project", "README.md"), "utf8"),
    "# hello\n".repeat(40),
  );
  assert.equal(
    await readFile(path.join(directory, "project", ".git", "HEAD"), "utf8"),
    "ref: refs/heads/work\n",
  );
});

test("an entry that points outside the destination is refused", async (t) => {
  // The whole reason this file exists. An archive's entry names are strings
  // chosen by whoever made it, and turning them into paths on this machine is
  // where every extraction vulnerability has ever lived.
  const directory = await temporaryDirectory(t);
  assert.equal(zipEntryTargetPath(directory, "../escape.txt"), undefined);
  assert.equal(zipEntryTargetPath(directory, "a/../../escape.txt"), undefined);
  assert.equal(zipEntryTargetPath(directory, "/etc/passwd"), undefined);
  assert.equal(
    zipEntryTargetPath(directory, `C:${String.fromCharCode(92)}Windows`),
    undefined,
  );
  assert.equal(zipEntryTargetPath(directory, ""), undefined);
  assert.equal(
    zipEntryTargetPath(directory, "src/index.ts"),
    path.join(directory, "src", "index.ts"),
  );

  // And the whole extraction fails rather than skipping the entry quietly: an
  // archive that tried is not one to unpack most of.
  await assert.rejects(
    extractZipArchive(buildZip([{ name: "../escape.txt", bytes: Buffer.from("no") }]), directory),
    ZipArchiveError,
  );
});

test("a symbolic link in an archive is never created", async (t) => {
  // A link is how a later entry writes through to somewhere outside the
  // destination, and a repository import has no need of one.
  const directory = await temporaryDirectory(t);
  const unpacked = await extractZipArchive(
    buildZip([
      { name: "root/link", bytes: Buffer.from("/etc/passwd"), mode: 0o120777 },
      { name: "root/file", bytes: Buffer.from("ok"), store: true },
    ]),
    directory,
  );
  assert.equal(unpacked.skipped, 1);
  assert.equal(unpacked.files, 1);
  assert.equal(await readFile(path.join(directory, "root", "file"), "utf8"), "ok");
});

test("a wrapper folder is recognised, and a loose file means there is none", () => {
  assert.equal(singleRootDirectory([{ name: "app/a" }, { name: "app/b/c" }]), "app");
  // A file sitting beside the folder means the archive is the repository
  // itself, so there is nothing to strip.
  assert.equal(
    singleRootDirectory([{ name: "app/a" }, { name: "README.md" }]),
    undefined,
  );
  assert.equal(
    singleRootDirectory([{ name: "app/a" }, { name: "other/b" }]),
    undefined,
  );
});

test("anything that is not a ZIP is refused as one", () => {
  assert.throws(
    () => readZipEntries(Buffer.from("this is a perfectly ordinary text file")),
    ZipArchiveError,
  );
  assert.throws(() => readZipEntries(Buffer.alloc(4)), ZipArchiveError);
});

test("an archive that unpacks to more than it may is stopped", async (t) => {
  const directory = await temporaryDirectory(t);
  const archive = buildZip([
    { name: "big/zeros.bin", bytes: Buffer.alloc(64 * 1024) },
  ]);
  // Compressed, this is a few dozen bytes. The limit is checked against what
  // it expands to, which is the only number a bomb cannot lie about and still
  // be a bomb.
  await assert.rejects(
    extractZipArchive(archive, directory, { maxBytes: 1024 }),
    ZipArchiveError,
  );
});
