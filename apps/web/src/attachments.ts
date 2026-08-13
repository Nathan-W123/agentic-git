import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    await mkdir(this.directory, { recursive: true });
    const id = `${randomBytes(16).toString("hex")}.${extension}`;
    await writeFile(path.join(this.directory, id), bytes);
    return id;
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
