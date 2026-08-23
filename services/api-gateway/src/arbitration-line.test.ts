import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitrationLine,
  namedDeferrals,
  type ArbitrationAnnouncement,
  type DeferredRef,
} from "./arbitration-line.js";

const BASE: ArbitrationAnnouncement = {
  held: "@Rhea",
  blockedByNames: [],
  holderNames: [],
  heldWork: '"rename the agent"',
  blockerWork: '"trim the settings text"',
  status: "approved_with_constraints",
  partial: true,
  grantedFiles: [],
  deferred: [],
};

const files = (...paths: string[]): DeferredRef[] =>
  paths.map((resourceId) => ({ resourceType: "file", resourceId }));

/**
 * The line as the room actually received it, kept whole so the four things
 * wrong with it can be named one at a time:
 *
 *   "@Rhea and work in flight have conflicting files — @Rhea starts on
 *    apps/web/public/styles.css now, apps/web/public/screen-chats.js,
 *    apps/web/src/assets.test.ts, GET /app.js, GET /index.html and 965 more
 *    once work in flight is done."
 */
const REPORTED: ArbitrationAnnouncement = {
  ...BASE,
  holderNames: ["@Hades"],
  grantedFiles: ["apps/web/public/styles.css"],
  deferred: [
    ...files(
      "apps/web/public/screen-chats.js",
      "apps/web/src/assets.test.ts",
    ),
    // What a deferred file takes with it, recorded one by one so enforcement
    // can check them — routes and symbols alike.
    { resourceType: "api", resourceId: "GET /app.js", implied: true },
    { resourceType: "api", resourceId: "GET /index.html", implied: true },
    ...Array.from({ length: 965 }, (_unused, index) => ({
      resourceType: "symbol",
      resourceId: `symbol_${String(index)}`,
      implied: true,
    })),
  ],
};

test("a partial admission names who holds the rest, not 'work in flight'", () => {
  // The decision sets `blockedBy` to nothing on purpose — this holder is
  // executing — so reading only that left the sentence with nobody in it,
  // twice: "@Rhea and work in flight have conflicting files ... once work in
  // flight is done".
  const line = arbitrationLine(REPORTED);

  assert.doesNotMatch(line, /work in flight/u, line);
  assert.match(line, /@Rhea and @Hades have conflicting/u, line);
  assert.match(line, /once @Hades is done/u, line);
});

test("a file's contents are not counted as further things lost", () => {
  // 969 withheld resources, of which 965 exist only because two files were
  // deferred. Counting them told the room a five-file plan had lost more
  // things than the repository has files.
  const line = arbitrationLine(REPORTED);

  assert.doesNotMatch(line, /965 more/u, line);
  assert.match(line, /apps\/web\/public\/screen-chats\.js/u, line);
  assert.match(line, /apps\/web\/src\/assets\.test\.ts/u, line);
  assert.equal(namedDeferrals(REPORTED.deferred).length, 2);
});

test("a route is not announced as a file", () => {
  const line = arbitrationLine(REPORTED);

  assert.doesNotMatch(line, /GET \//u, line);
});

test("both halves of a split get a verb", () => {
  // "starts on styles.css now, screen-chats.js and 965 more once work in
  // flight is done" — no way to see where what it got ended and what it is
  // waiting for began.
  const line = arbitrationLine(REPORTED);

  assert.match(line, /starts on \S+ now and takes /u, line);
});

test("a split finer than a file names the symbols, and does not call them files", () => {
  // Nothing implied here: these symbols are the loss, not a consequence of
  // one, and they are the only thing there is to name.
  const line = arbitrationLine({
    ...BASE,
    holderNames: ["@Zeus"],
    grantedFiles: ["services/api-gateway/src/server.ts"],
    deferred: [
      { resourceType: "symbol", resourceId: "renameAgent" },
      { resourceType: "symbol", resourceId: "agentIdentityFor" },
    ],
  });

  assert.match(line, /have conflicting work/u, line);
  assert.doesNotMatch(line, /conflicting files/u, line);
  assert.match(line, /takes renameAgent, agentIdentityFor/u, line);
});

test("a symbol withheld beside a file survives, because type is not the test", () => {
  // The case a type filter would have swallowed. A split can lose a whole
  // file and, in a different file it keeps, one symbol — and that symbol is
  // the entire reason splitting exists, so it has to be in the sentence.
  const line = arbitrationLine({
    ...BASE,
    holderNames: ["@Zeus"],
    grantedFiles: ["services/api-gateway/src/server.ts"],
    deferred: [
      ...files("apps/web/public/data.js"),
      { resourceType: "symbol", resourceId: "renameAgent" },
      {
        resourceType: "symbol",
        resourceId: "somethingInsideDataJs",
        implied: true,
      },
    ],
  });

  assert.match(line, /apps\/web\/public\/data\.js/u, line);
  assert.match(line, /renameAgent/u, line);
  assert.doesNotMatch(line, /somethingInsideDataJs/u, line);
  // Mixed granularity is not "files", and saying so was how a route came to
  // be announced as one.
  assert.match(line, /have conflicting work/u, line);
});

test("nothing withheld and nobody holding still reads as a sentence", () => {
  const line = arbitrationLine({ ...BASE, partial: true });

  assert.equal(
    line,
    "⚖️ @Rhea and work in flight have conflicting files — @Rhea starts on " +
      "the free part now and takes the rest once work in flight is done.",
  );
});

test("one agent's two colliding tasks are still named once, with the order", () => {
  // Unchanged by any of the above, and asserted here so a rewrite of the
  // partial branch cannot quietly take it with it.
  const line = arbitrationLine({
    ...BASE,
    held: "@Claude (Nathan)",
    blockedByNames: ["@Claude (Nathan)"],
    status: "blocked",
    partial: false,
  });

  assert.equal(
    line,
    '⚖️ @Claude (Nathan) is working on multiple tasks that conflict — it ' +
      'will do "trim the settings text" first, then "rename the agent".',
  );
  assert.equal(line.split("@Claude (Nathan)").length - 1, 1, line);
});

test("a sequenced decision still names its blocker from blockedBy", () => {
  const line = arbitrationLine({
    ...BASE,
    blockedByNames: ["@Zeus"],
    // Present, and deliberately not what the sentence should reach for first.
    holderNames: ["@Hades"],
    status: "sequenced",
    partial: false,
  });

  assert.equal(
    line,
    "⚖️ @Rhea and @Zeus have conflicting files — @Rhea starts once @Zeus " +
      "is done.",
  );
});

test("more names than fit are counted, and the count is of what was named", () => {
  const deferred = files(
    ...Array.from({ length: 9 }, (_unused, index) => `src/file_${String(index)}.ts`),
  );
  const line = arbitrationLine({ ...BASE, holderNames: ["@Zeus"], deferred });

  assert.match(line, /and 5 more once/u, line);
});
