/**
 * Shortening resource ids down to what a sentence can carry.
 *
 * Coordinator lines name the files a decision touched, and a repo-relative
 * path spends most of its width on the part every name in the room shares:
 * "⚖️ Starting on apps/web/public/screen-chats.js — services/api-gateway/src/
 * server.ts is leased to another task" says "apps" and "services" to a reader
 * who is already looking at this repository and wants the file.
 *
 * The whole difficulty is that basenames collide. `packages/shared-types/src/
 * index.ts`, `apps/cli/src/index.ts` and `services/api-gateway/src/index.ts`
 * all shorten to `index.ts`, and "Starting on index.ts — index.ts is leased"
 * is worse than the paths were. So shortening is decided per message, over
 * every name that message will print at once, and a name keeps exactly as much
 * of its tail as it needs to stay distinct from the others beside it.
 */

/** As much of a resource as a display name needs. */
export interface DisplayableResource {
  resourceType: string;
  resourceId: string;
}

/** The last `depth` segments of a path, joined. */
function tail(segments: readonly string[], depth: number): string {
  return segments.slice(Math.max(0, segments.length - depth)).join("/");
}

/**
 * Display names for one message's resources, in the order they were given.
 *
 * Only files are shortened. A symbol is not a path — `renderThreadList` has no
 * leading directory to drop — and neither is a route: `GET /app.js` cut to its
 * last segment would read as a file, which is the confusion this is meant to
 * end, not spread.
 */
export function shortenResourceNamesForMessage(
  resources: readonly DisplayableResource[],
): string[] {
  const display = resources.map((entry) => entry.resourceId);

  // Grouped by basename, because two ids ending in different file names can
  // never collide however far back either is unwound. Each group settles its
  // own depth, so one pair of colliding names does not lengthen every other
  // name in the sentence.
  const groups = new Map<string, { index: number; segments: string[] }[]>();
  resources.forEach((entry, index) => {
    if (entry.resourceType !== "file") {
      return;
    }
    const segments = entry.resourceId.split("/");
    const base = segments.at(-1) ?? entry.resourceId;
    const group = groups.get(base);
    if (group === undefined) {
      groups.set(base, [{ index, segments }]);
    } else {
      group.push({ index, segments });
    }
  });

  for (const group of groups.values()) {
    const distinct = new Set(
      group.map((entry) => entry.segments.join("/")),
    ).size;
    const deepest = Math.max(
      ...group.map((entry) => entry.segments.length),
    );
    // All of a group grows together, so the reader compares like with like —
    // `shared-types/src/index.ts` against `cli/src/index.ts`, not against a
    // bare `index.ts`. The depth cap is for the same path named twice in one
    // message: no amount of tail separates those, and the full path is the
    // honest answer.
    let depth = 1;
    while (
      depth < deepest &&
      new Set(group.map((entry) => tail(entry.segments, depth))).size < distinct
    ) {
      depth += 1;
    }
    for (const entry of group) {
      display[entry.index] = tail(entry.segments, depth);
    }
  }

  return display;
}
