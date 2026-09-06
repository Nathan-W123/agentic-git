import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Files posted into a channel, kept beside the database.
 *
 * On disk rather than in the store because these are bytes, and every backend
 * would have had to grow a blob column and a migration to hold them. The
 * deployment that persists the SQLite file persists this directory next to it,
 * so durability is the same without three implementations of it.
 *
 * The type allowlist is the security boundary, and it is short on purpose.
 * SVG is absent and stays absent: it is a document that can carry script, so
 * serving one from this origin would be self-inflicted cross-site scripting.
 * HTML is absent for exactly the same reason. What is here is a raster image
 * a browser will only ever draw, a ZIP a browser never renders at all, and
 * Markdown, which is text — and everything that is not an image is served
 * with `Content-Disposition: attachment` on top of `nosniff`, so a browser
 * downloads it rather than deciding for itself what it is looking at.
 */

const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/zip": "zip",
  // What Windows browsers send for a `.zip` chosen from disk. The same bytes
  // and the same signature check; refusing it would only mean the feature did
  // not work on the platform a good share of these uploads come from.
  "application/x-zip-compressed": "zip",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

/**
 * The leading bytes each binary format must actually start with.
 *
 * Deliberately only the signature, never the rest of the container: a valid
 * file with an unusual but legal variant header — an odd JPEG segment order, a
 * WebP the encoder wrote a little differently — has to keep working, because
 * the point of this check is to catch bytes that are not the format at all,
 * not to referee the format's own dialects.
 *
 * `undefined` where a byte is not fixed: WebP's signature is `RIFF`, four
 * bytes of length that are whatever the file's length is, then `WEBP`.
 *
 * A list per format rather than one signature, because one of them has three
 * legal openings: a ZIP begins `PK\x03\x04` ordinarily, `PK\x05\x06` when it
 * holds nothing at all, and `PK\x07\x08` when it was written as a spanned
 * archive. Accepting only the first would refuse an empty archive, which is a
 * real thing a person can produce rather than a corrupt file.
 */
const SIGNATURES: Record<
  string,
  ReadonlyArray<ReadonlyArray<number | undefined>>
> = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [
    [
      0x52, 0x49, 0x46, 0x46,
      undefined, undefined, undefined, undefined,
      0x57, 0x45, 0x42, 0x50,
    ],
  ],
  zip: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
};

/** Whether the bytes begin any of the ways the named format may begin. */
function signatureMatches(bytes: Buffer, extension: string): boolean {
  const alternatives = SIGNATURES[extension];
  if (alternatives === undefined) {
    return false;
  }
  return alternatives.some(
    (signature) =>
      bytes.length >= signature.length &&
      signature.every(
        (byte, index) => byte === undefined || bytes[index] === byte,
      ),
  );
}

/**
 * Whether these bytes are the text they claim to be.
 *
 * Markdown has no signature — it is text, and text is precisely the thing
 * with no fixed opening — so the check is what text *is* rather than what it
 * starts with: decodable as UTF-8 without loss, and free of the control
 * characters a document does not contain. That is what stops an executable or
 * a disk image being stored as `.md` and served back from this origin.
 *
 * Tab, newline and carriage return are text and are allowed. A byte order
 * mark is left alone: editors write them, and it is not a control code.
 */
function isAllowedTextAttachment(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  // `toString` replaces anything undecodable with U+FFFD rather than failing,
  // so the round trip is the test: bytes that were not UTF-8 do not come back.
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return false;
  }
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text);
}

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  zip: "application/zip",
  md: "text/markdown",
};

/**
 * The exact shape of an id this store issues.
 *
 * Written once and shared by everything that takes an id back from outside
 * this class — a URL, a message body — because those are where a `..` gets
 * in. The pattern is not global, so `test` never carries an offset between
 * calls.
 */
export const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{32}\.(?:png|jpg|gif|webp|zip|md)$/u;

/** What one stored id is served as, or nothing if it is not an id at all. */
export function attachmentContentType(id: string): string | undefined {
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    return undefined;
  }
  return EXTENSION_TYPES[id.split(".")[1] ?? ""];
}

/**
 * Eight megabytes.
 *
 * Comfortably a full-page screenshot at retina scale, and small enough that a
 * handful of them cannot fill a volume the database is also living on. The
 * same ceiling for an archive posted into a room, because that is somebody
 * handing a colleague something to look at; a whole repository arriving as a
 * ZIP has its own route and its own, larger limit.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export class AttachmentTypeError extends Error {}

export class AttachmentStore {
  public constructor(private readonly directory: string) {}

  /**
   * Stores one file and answers with the id it is addressed by.
   *
   * The id carries the extension, which is what lets `read` answer with a
   * content type it derived from the allowlist rather than from anything the
   * uploader said. A caller's own claim about the bytes is never trusted
   * further than choosing which allowlisted entry to check it against.
   */
  public async save(bytes: Buffer, contentType: string): Promise<string> {
    const extension = TYPES[contentType.split(";")[0]?.trim() ?? ""];
    if (extension === undefined) {
      throw new AttachmentTypeError(
        "Attachments must be a PNG, JPEG, GIF or WebP image, a ZIP archive " +
          `or a Markdown file (not ${contentType})`,
      );
    }
    if (bytes.length === 0) {
      throw new AttachmentTypeError("That file was empty");
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTypeError(
        `Attachments are at most ${String(
          Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024)),
        )} MB`,
      );
    }
    // The declared type chose which format to check against; the bytes decide
    // whether that claim was true. Without this, anything at all could be
    // stored as `.png` and served from this origin — the read path derives its
    // content type from the extension and sends `nosniff`, so a browser would
    // not execute it, but hosting attacker-chosen bytes on a trusted origin is
    // worth refusing on its own.
    const genuine =
      extension === "md"
        ? isAllowedTextAttachment(bytes)
        : signatureMatches(bytes, extension);
    if (!genuine) {
      throw new AttachmentTypeError(
        extension === "md"
          ? "That file is not Markdown text"
          : extension === "zip"
            ? "That file is not a valid ZIP archive"
            : `That file is not a valid ${extension.toUpperCase()} image`,
      );
    }
    await mkdir(this.directory, { recursive: true });
    const id = `${randomBytes(16).toString("hex")}.${extension}`;
    await writeFile(path.join(this.directory, id), bytes);
    return id;
  }

  /**
   * Where one attachment sits on disk, or nothing.
   *
   * For handing an agent something it can open. A task runs with a checkout
   * and a filesystem, so the shortest path from "somebody pasted a
   * screenshot" to "the agent looked at it" is the path itself — no copy, no
   * new column, no bytes travelling through an objective. That argument is
   * even stronger for the types added later: an agent cannot be shown a ZIP
   * of logs at all, but it can be told where one is and open it.
   *
   * The same strict pattern as `read`, for the same reason: the id is chosen
   * by this class, but it comes back through a URL and a message body, and
   * those are where a `..` gets in. Existence is checked, so a caller is
   * never handed a path to nothing.
   */
  public async pathFor(id: string): Promise<string | undefined> {
    if (!ATTACHMENT_ID_PATTERN.test(id)) {
      return undefined;
    }
    const full = path.join(this.directory, id);
    try {
      await access(full);
      return full;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads one attachment back, or nothing.
   *
   * The id is checked against a strict pattern before it reaches the
   * filesystem. It is chosen by this class and never by a caller, but it
   * arrives back through a URL, and a URL is the one place a `..` gets in.
   */
  public async read(
    id: string,
  ): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    const contentType = attachmentContentType(id);
    if (contentType === undefined) {
      return undefined;
    }
    try {
      return {
        bytes: await readFile(path.join(this.directory, id)),
        contentType,
      };
    } catch {
      return undefined;
    }
  }
}
