import assert from "node:assert/strict";
import test from "node:test";

import { shortenResourceNamesForMessage } from "./resource-display-name.js";

const files = (...paths: string[]) =>
  paths.map((resourceId) => ({ resourceType: "file", resourceId }));

test("a file with nothing to collide with keeps only its name", () => {
  assert.deepEqual(
    shortenResourceNamesForMessage(
      files("apps/web/public/screen-chats.js", "apps/web/src/assets.test.ts"),
    ),
    ["screen-chats.js", "assets.test.ts"],
  );
});

test("colliding names keep the least tail that tells them apart", () => {
  // The three this repository actually has. `index.ts` three times says
  // nothing, and the full paths spend their width on `packages`, `apps` and
  // `services` — the part the reader already knows.
  assert.deepEqual(
    shortenResourceNamesForMessage(
      files(
        "packages/shared-types/src/index.ts",
        "apps/cli/src/index.ts",
        "services/api-gateway/src/index.ts",
      ),
    ),
    [
      "shared-types/src/index.ts",
      "cli/src/index.ts",
      "api-gateway/src/index.ts",
    ],
  );
});

test("one collision does not lengthen the names beside it", () => {
  // Depth is settled per basename. Two ids ending in different file names can
  // never collide however far back either is unwound, so `styles.css` has no
  // reason to grow because two `index.ts` did.
  assert.deepEqual(
    shortenResourceNamesForMessage(
      files(
        "apps/web/src/index.ts",
        "apps/web/public/styles.css",
        "apps/cli/src/index.ts",
      ),
    ),
    ["web/src/index.ts", "styles.css", "cli/src/index.ts"],
  );
});

test("a symbol is not a path and is left alone", () => {
  // `renderThreadList` has no leading directory to drop, and `GET /app.js` cut
  // to its last segment would read as a file — which is the confusion this is
  // meant to end, not spread.
  assert.deepEqual(
    shortenResourceNamesForMessage([
      { resourceType: "symbol", resourceId: "renderThreadList" },
      { resourceType: "api", resourceId: "GET /app.js" },
      { resourceType: "file", resourceId: "services/api-gateway/src/server.ts" },
    ]),
    ["renderThreadList", "GET /app.js", "server.ts"],
  );
});

test("the same file named twice shortens the same way, and terminates", () => {
  // No depth separates a path from itself. Growing until they differ would
  // never stop, so the group settles as soon as it is as distinct as its
  // members are.
  assert.deepEqual(
    shortenResourceNamesForMessage(files("a/b/c.ts", "a/b/c.ts")),
    ["c.ts", "c.ts"],
  );
});

test("a path shorter than the depth its group needs is used whole", () => {
  assert.deepEqual(
    shortenResourceNamesForMessage(files("index.ts", "apps/cli/src/index.ts")),
    ["index.ts", "src/index.ts"],
  );
});

test("order is preserved, because the caller slices by position", () => {
  // `arbitrationLine` shortens granted and deferred together and then splits
  // the result at `grantedFiles.length`. A reordered return would hand the
  // room the wrong half of its own decision.
  const resources = [
    ...files("z/last.ts"),
    { resourceType: "symbol", resourceId: "aSymbol" },
    ...files("a/first.ts"),
  ];

  assert.deepEqual(shortenResourceNamesForMessage(resources), [
    "last.ts",
    "aSymbol",
    "first.ts",
  ]);
});
