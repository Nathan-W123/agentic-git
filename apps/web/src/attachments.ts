import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Images posted into a channel, kept as files beside the database.
 *
 * On disk rather than in the store because these are bytes, and every backend
 * would have had to grow a blob column and a migration to hold them. The
 * deployment that persists the SQLite file persists this directory next to it,
 * so durability is the same without three implementations of it.
 *
 * The type allowlist is the security boundary, and it is short on purpose.
 * SVG is absent and stays absent: it is a document that can carry script, so
 * serving one from this origin would be self-inflicted cross-site scripting.
 * Everything here is a raster format a browser will only ever draw.
 */

const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The leading bytes each allowlisted format must actually start with.
 *
 * Deliberately only the signature, never the rest of the container: a valid
 * file with an unusual but legal variant header — an odd JPEG segment order, a
 * WebP the encoder wrote a little differently — has to keep working, because
 * the point of this check is to catch bytes that are not the format at all,
 * not to referee the format's own dialects.
 *
 * `undefined` where a byte is not fixed: WebP's signature is `RIFF`, four
 * bytes of length that are whatever the file's length is, then `WEBP`.
 */
const SIGNATURES: Record<string, ReadonlyArray<number | undefined>> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  webp: [
    0x52, 0x49, 0x46, 0x46,
    undefined, undefined, undefined, undefined,
    0x57, 0x45, 0x42, 0x50,
  ],
};

/** Whether the bytes begin the way the named format has to begin. */
function signatureMatches(bytes: Buffer, extension: string): boolean {
  const signature = SIGNATURES[extension];
  if (signature === undefined) {
    return false;
  }
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every(
    (byte, index) => byte === undefined || bytes[index] === byte,
  );
}

const EXTENSION_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([mime, extension]) => [extension, mime]),
);

/**
 * Eight megabytes.
 *
 * Comfortably a full-page screenshot at retina scale, and small enough that a
 * handful of them cannot fill a volume the database is also living on.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export class AttachmentTypeError extends Error {}

export class AttachmentStore {
  public constructor(private readonly directory: string) {}

  /**
   * Stores one image and answers with the id it is addressed by.
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
        `Images must be PNG, JPEG, GIF or WebP (not ${contentType})`,
      );
    }
    if (bytes.length === 0) {
      throw new AttachmentTypeError("The image was empty");
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTypeError(
        `Images are at most ${String(
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
    if (!signatureMatches(bytes, extension)) {
      throw new AttachmentTypeError(
        `That file is not a valid ${extension.toUpperCase()} image`,
      );
    }
    await mkdir(this.directory, { recursive: true });
    const id = `${randomBytes(16).toString("hex")}.${extension}`;
    await writeFile(path.join(this.directory, id), bytes);
    return id;
  }

  /**
   * Where one image sits on disk, or nothing.
   *
   * For handing an agent something it can open. A task runs with a checkout
   * and a filesystem, so the shortest path from "somebody pasted a
   * screenshot" to "the agent looked at it" is the path itself — no copy, no
   * new column, no bytes travelling through an objective.
   *
   * The same strict pattern as `read`, for the same reason: the id is chosen
   * by this class, but it comes back through a URL and a message body, and
   * those are where a `..` gets in. Existence is checked, so a caller is
   * never handed a path to nothing.
   */
  public async pathFor(id: string): Promise<string | undefined> {
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/u.test(id)) {
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
   * Reads one image back, or nothing.
   *
   * The id is checked against a strict pattern before it reaches the
   * filesystem. It is chosen by this class and never by a caller, but it
   * arrives back through a URL, and a URL is the one place a `..` gets in.
   */
  public async read(
    id: string,
  ): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/u.test(id)) {
      return undefined;
    }
    const contentType = EXTENSION_TYPES[id.split(".")[1] ?? ""];
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
