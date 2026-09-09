import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Reading a ZIP, so a folder from somebody's laptop can become a repository.
 *
 * Written here rather than installed, because the format's read side is a
 * central directory and two compression methods, and `node:zlib` already
 * carries the only one that is not a memory copy. A dependency for this would
 * be a supply chain in exchange for two hundred lines.
 *
 * Everything below treats the archive as hostile input. It arrives over HTTP
 * from a browser, its entry names are attacker-chosen strings, and the whole
 * job is to turn those into paths on this machine — which is the exact shape
 * of every archive extraction vulnerability ever written. So: names are
 * refused rather than sanitised when they leave the destination, symbolic
 * links are never created, and both the number of entries and the total
 * decompressed size are capped so a small upload cannot fill the disk.
 */

export class ZipArchiveError extends Error {}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** The two methods anything writing a repository ZIP actually uses. */
const STORED = 0;
const DEFLATED = 8;

/**
 * Ceilings, not tuning.
 *
 * A ZIP can claim any decompressed size it likes, and a few hundred kilobytes
 * of zeros expands to gigabytes — the classic bomb. Both limits are checked
 * while extracting rather than from the header, because the header is the
 * attacker's own claim about what they sent.
 */
export const MAX_ARCHIVE_ENTRIES = 200_000;
export const MAX_ARCHIVE_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

export interface ZipEntry {
  /** The name exactly as the archive carries it, separators and all. */
  readonly name: string;
  readonly isDirectory: boolean;
  /** The Unix mode, when the archive was written somewhere that has one. */
  readonly mode: number | undefined;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ExtractedArchive {
  /** How many files were written; directories are not counted. */
  readonly files: number;
  /** Entries skipped because they were symbolic links or devices. */
  readonly skipped: number;
  readonly bytes: number;
}

function readUInt32(archive: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > archive.length) {
    throw new ZipArchiveError("That ZIP file is truncated");
  }
  return archive.readUInt32LE(offset);
}

function readUInt16(archive: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > archive.length) {
    throw new ZipArchiveError("That ZIP file is truncated");
  }
  return archive.readUInt16LE(offset);
}

/**
 * A 64-bit field, refused rather than silently truncated once it exceeds what
 * a JavaScript number holds exactly. Nothing this reads is anywhere near that
 * size, so the only value that reaches it is a lie.
 */
function readUInt64(archive: Buffer, offset: number): number {
  if (offset < 0 || offset + 8 > archive.length) {
    throw new ZipArchiveError("That ZIP file is truncated");
  }
  const value = archive.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipArchiveError("That ZIP file declares an impossible size");
  }
  return Number(value);
}

/**
 * Where the central directory starts, and how many entries it holds.
 *
 * The end-of-central-directory record is at the very end of the file, after a
 * comment of any length up to 64 KB — so it is found by scanning backwards
 * for its signature, which is what every reader of this format does.
 */
function locateCentralDirectory(archive: Buffer): {
  offset: number;
  entries: number;
} {
  const smallest = 22;
  if (archive.length < smallest) {
    throw new ZipArchiveError("That file is too small to be a ZIP archive");
  }
  const earliest = Math.max(0, archive.length - smallest - 0xffff);
  let end = -1;
  for (let at = archive.length - smallest; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) {
    throw new ZipArchiveError("That file is not a ZIP archive");
  }
  let entries = readUInt16(archive, end + 10);
  let offset = readUInt32(archive, end + 16);
  // Zip64. The 32-bit fields saturate, and the real ones live in a second
  // record the locator immediately before this one points at. Reached by
  // anything holding more than 65535 files, which a repository with its
  // history unpacked can genuinely be.
  if (entries === 0xffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || readUInt32(archive, locator) !== ZIP64_LOCATOR) {
      throw new ZipArchiveError("That ZIP file is missing its Zip64 index");
    }
    const record = readUInt64(archive, locator + 8);
    if (readUInt32(archive, record) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
      throw new ZipArchiveError("That ZIP file has a damaged Zip64 index");
    }
    entries = readUInt64(archive, record + 32);
    offset = readUInt64(archive, record + 48);
  }
  return { offset, entries };
}

/**
 * The Zip64 extra field, which restates whichever sizes did not fit in 32
 * bits. Order is fixed and fields are present only when the value they
 * replace was saturated, so this walks the same three in the same order.
 */
function zip64Sizes(
  extra: Buffer,
  wanted: { uncompressed: boolean; compressed: boolean; offset: boolean },
): {
  uncompressedSize?: number | undefined;
  compressedSize?: number | undefined;
  offset?: number | undefined;
} {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    if (at + 4 + size > extra.length) {
      break;
    }
    if (id === 0x0001) {
      const body = extra.subarray(at + 4, at + 4 + size);
      const found: {
        uncompressedSize?: number | undefined;
        compressedSize?: number | undefined;
        offset?: number | undefined;
      } = {};
      let cursor = 0;
      const next = (): number | undefined => {
        if (cursor + 8 > body.length) {
          return undefined;
        }
        const value = readUInt64(body, cursor);
        cursor += 8;
        return value;
      };
      if (wanted.uncompressed) {
        found.uncompressedSize = next();
      }
      if (wanted.compressed) {
        found.compressedSize = next();
      }
      if (wanted.offset) {
        found.offset = next();
      }
      return found;
    }
    at += 4 + size;
  }
  return {};
}

/**
 * Every entry the archive's own index lists.
 *
 * Read from the central directory rather than by walking local headers, which
 * is not merely conventional: a streamed ZIP writes zero sizes into the local
 * header and puts the real ones in a descriptor *after* the data, so a reader
 * that trusts local headers cannot find the end of the first file.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  const { offset, entries: declared } = locateCentralDirectory(archive);
  if (declared > MAX_ARCHIVE_ENTRIES) {
    throw new ZipArchiveError(
      `That ZIP holds more than ${String(MAX_ARCHIVE_ENTRIES)} files`,
    );
  }
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < declared; index += 1) {
    if (readUInt32(archive, at) !== CENTRAL_ENTRY) {
      throw new ZipArchiveError("That ZIP file has a damaged index");
    }
    const madeBy = readUInt16(archive, at + 4);
    const flags = readUInt16(archive, at + 8);
    const compressionMethod = readUInt16(archive, at + 10);
    const nameLength = readUInt16(archive, at + 28);
    const extraLength = readUInt16(archive, at + 30);
    const commentLength = readUInt16(archive, at + 32);
    const externalAttributes = readUInt32(archive, at + 38);
    let compressedSize = readUInt32(archive, at + 20);
    let uncompressedSize = readUInt32(archive, at + 24);
    let localHeaderOffset = readUInt32(archive, at + 42);
    const nameStart = at + 46;
    const nameBytes = archive.subarray(nameStart, nameStart + nameLength);
    if (nameBytes.length !== nameLength) {
      throw new ZipArchiveError("That ZIP file is truncated");
    }
    // UTF-8 when the language encoding flag is set, and in practice when it
    // is not either: every writer this will meet emits UTF-8, and the
    // alternative is a code page table for names that are nearly always
    // ASCII.
    const name = nameBytes.toString("utf8");
    const extra = archive.subarray(
      nameStart + nameLength,
      nameStart + nameLength + extraLength,
    );
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const wide = zip64Sizes(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      });
      uncompressedSize = wide.uncompressedSize ?? uncompressedSize;
      compressedSize = wide.compressedSize ?? compressedSize;
      localHeaderOffset = wide.offset ?? localHeaderOffset;
    }
    // Encryption is refused rather than mangled: the bytes would decompress
    // to noise and land in a repository as if they were files.
    if ((flags & 0x0001) !== 0) {
      throw new ZipArchiveError("That ZIP file is encrypted");
    }
    // The high byte of "version made by" is the platform. 3 is Unix, and only
    // then does the top half of the external attributes hold a file mode.
    const mode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : undefined;
    entries.push({
      name,
      isDirectory: name.endsWith("/") || name.endsWith("\\"),
      mode,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, decompressed. */
function entryBytes(archive: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (readUInt32(archive, header) !== LOCAL_HEADER) {
    throw new ZipArchiveError(`That ZIP file is damaged around ${entry.name}`);
  }
  const nameLength = readUInt16(archive, header + 26);
  const extraLength = readUInt16(archive, header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) {
    throw new ZipArchiveError("That ZIP file is truncated");
  }
  const raw = archive.subarray(start, end);
  if (entry.compressionMethod === STORED) {
    return Buffer.from(raw);
  }
  if (entry.compressionMethod !== DEFLATED) {
    throw new ZipArchiveError(
      `${entry.name} uses a compression this reader does not know ` +
        `(method ${String(entry.compressionMethod)})`,
    );
  }
  try {
    // Bounded by the size the index declared, so a bomb is refused by zlib
    // itself rather than after it has already allocated the memory.
    return inflateRawSync(raw, {
      maxOutputLength: Math.max(entry.uncompressedSize, 1),
    });
  } catch (error) {
    throw new ZipArchiveError(
      `${entry.name} could not be decompressed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Where one entry may be written, or nothing if it may not be written at all.
 *
 * Absolute paths, Windows drive letters, UNC prefixes and any `..` segment are
 * refused rather than stripped. Stripping is how these bugs survive: `....//`
 * becomes `../` under a single pass, and a name that had to be repaired to be
 * safe was never a name this archive should have contained.
 */
export function zipEntryTargetPath(
  destination: string,
  name: string,
): string | undefined {
  const normalized = name.replace(/\\/gu, "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  const segments = normalized.split("/").filter((part) => part !== "");
  if (segments.length === 0 || segments.some((part) => part === "..")) {
    return undefined;
  }
  const root = path.resolve(destination);
  const target = path.resolve(root, ...segments);
  // Belt and braces: the segment check above already refuses traversal, and
  // this catches anything the platform resolves differently than expected.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return undefined;
  }
  return target;
}

/**
 * The single folder everything in the archive sits inside, if there is one.
 *
 * Zipping a folder produces `project/...`, and extracting that as the
 * repository would give a checkout with one directory in it and nothing else.
 * Everything sharing one first segment is what identifies that wrapper — and
 * an archive whose entries sit at the top level has no wrapper to strip, so
 * this answers nothing and the caller uses the directory as it is.
 */
export function singleRootDirectory(
  entries: ReadonlyArray<{ name: string }>,
): string | undefined {
  let root: string | undefined;
  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/gu, "/");
    const segments = normalized.split("/").filter((part) => part !== "");
    const [first, ...rest] = segments;
    if (first === undefined) {
      continue;
    }
    // A top-level file — `README.md` beside the folder — means there is no
    // single wrapper, even if everything else agrees on one.
    if (rest.length === 0 && !normalized.endsWith("/")) {
      return undefined;
    }
    if (root === undefined) {
      root = first;
    } else if (root !== first) {
      return undefined;
    }
  }
  return root;
}

/**
 * Writes the archive out under `destination`.
 *
 * Directories are created as they are needed rather than trusting the
 * archive's own directory entries, which are optional and frequently absent.
 * Symbolic links are skipped: creating one from an untrusted archive is how a
 * later entry writes through it to somewhere outside the destination, and a
 * repository import has no need of them.
 */
export async function extractZipArchive(
  archive: Buffer,
  destination: string,
  options: { maxBytes?: number | undefined } = {},
): Promise<ExtractedArchive> {
  const limit = options.maxBytes ?? MAX_ARCHIVE_EXTRACTED_BYTES;
  const entries = readZipEntries(archive);
  await mkdir(destination, { recursive: true });
  let files = 0;
  let skipped = 0;
  let written = 0;
  for (const entry of entries) {
    const target = zipEntryTargetPath(destination, entry.name);
    if (target === undefined) {
      throw new ZipArchiveError(
        `That ZIP tries to write outside the folder it is being unpacked ` +
          `into (${entry.name})`,
      );
    }
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    // A symlink, a socket, a device. `S_IFLNK` is 0xa000 in the top four bits
    // of the mode; anything that is not a plain file is not a repository.
    if (entry.mode !== undefined && (entry.mode & 0xf000) !== 0 && (entry.mode & 0xf000) !== 0x8000) {
      skipped += 1;
      continue;
    }
    written += entry.uncompressedSize;
    if (written > limit) {
      throw new ZipArchiveError(
        "That ZIP unpacks to more than this deployment will accept",
      );
    }
    const bytes = entryBytes(archive, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    // The executable bit, and only that: an archive does not get to decide
    // that a file in this deployment is world-writable or setuid.
    if (entry.mode !== undefined && (entry.mode & 0o111) !== 0) {
      await chmod(target, 0o755);
    }
    files += 1;
  }
  return { files, skipped, bytes: written };
}
