import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Turning the images an agent wrote into images the room can show.
 *
 * The control plane cannot read the worker's disk. The worker can, and it is
 * the only party that can, so lifting the bytes has to happen here — on the
 * way past, in the one place every line an agent produces already goes
 * through.
 *
 * A marker rather than a tool call, because the marker works for every vendor
 * without any of them implementing anything: it is prose, and all three CLIs
 * write prose. `SHOW_IMAGES_DIRECTIVE` is what tells the agent to write one.
 */

/**
 * A markdown image whose target is not already a URL or a stored attachment.
 *
 * The extension is part of the match rather than checked afterwards, so an
 * ordinary link to a document is never mistaken for a picture. The target
 * stops at the first `)` — a filename containing one is not worth the
 * ambiguity, and an agent that produces one gets its filename back unchanged.
 */
const LOCAL_IMAGE = /!\[([^\]]*)\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\)/giu;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Eight megabytes, matching `MAX_ATTACHMENT_BYTES` on the store.
 *
 * Checked here as well as there so an agent that renders a 200 MB image does
 * not have it read into this process only to be refused a round trip later.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Four, matching what a promoted change set is allowed to lift.
 *
 * A task that regenerated a sprite sheet should not post forty pictures into
 * a room, and the number is the same in both paths so the answer to "how many
 * will I get" does not depend on which one ran.
 */
const MAX_IMAGES = 4;

/**
 * The file this marker points at, or `undefined` if it is not ours to read.
 *
 * The workspace is the boundary, and it is the whole security story here. An
 * agent runs under the account of the person who installed it and can already
 * read their disk, so this is not about what the agent can reach — it is
 * about what a *task description* can make it post. An objective written by
 * somebody else in the room must not be able to name `~/.ssh/id_rsa` and have
 * the room render it; keeping the resolved path inside the workspace is what
 * stops that, and it costs an agent nothing because the workspace is where it
 * was already working.
 *
 * `realpath` is deliberately not used. A workspace on a machine where the
 * temp directory is a symlink — every macOS install, `/var` to `/private/var`
 * — resolves to a prefix that no longer matches, and the effect would be that
 * the feature silently does nothing on one platform.
 */
function insideWorkspace(
  workspacePath: string,
  target: string,
): string | undefined {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return resolved;
}

/**
 * Replaces local image markers in `text` with stored attachments.
 *
 * Best effort throughout, and the failure mode is always the same one: the
 * marker is left exactly as the agent wrote it. That reads as the filename it
 * already was, which is no worse than what this feature replaced and is not
 * something anybody has to be told about.
 *
 * The same file referenced twice is uploaded once. Agents do that — a
 * screenshot named in a summary and again in a caption — and paying twice for
 * the same bytes shows up as two copies in the room.
 */
export async function liftLocalImages(
  text: string,
  options: {
    workspacePath: string;
    upload: (bytes: Buffer, contentType: string) => Promise<string | undefined>;
  },
): Promise<string> {
  if (!text.includes("](")) {
    return text;
  }
  const matches = [...text.matchAll(LOCAL_IMAGE)];
  if (matches.length === 0) {
    return text;
  }
  const uploaded = new Map<string, string>();
  let lifted = 0;
  let result = text;
  for (const match of matches) {
    const whole = match[0];
    const alt = match[1] ?? "";
    const target = match[2] ?? "";
    // Already a stored image, or somewhere on the web. Neither is ours.
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
      continue;
    }
    const known = uploaded.get(target);
    if (known !== undefined) {
      result = result.replace(whole, `![${alt}](attachment:${known})`);
      continue;
    }
    if (lifted >= MAX_IMAGES) {
      continue;
    }
    const file = insideWorkspace(options.workspacePath, target);
    if (file === undefined) {
      continue;
    }
    const extension = file.toLowerCase().split(".").pop() ?? "";
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) {
      continue;
    }
    try {
      // Sized before it is read, so a huge file is refused rather than pulled
      // into memory to find out how big it was.
      const info = await stat(file);
      if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) {
        continue;
      }
      const id = await options.upload(await readFile(file), contentType);
      if (id === undefined) {
        continue;
      }
      uploaded.set(target, id);
      lifted += 1;
      result = result.replace(whole, `![${alt}](attachment:${id})`);
    } catch {
      // Gone between being named and being read, or unreadable. The marker
      // stays as written.
      continue;
    }
  }
  return result;
}
