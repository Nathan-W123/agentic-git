/**
 * The review surface: several files, their commits, and what people said.
 *
 * A branch review is not one diff. It is a list of commits, a file at a time,
 * and remarks pinned to particular lines of particular revisions — and the
 * only part of that a browser can get wrong silently is the splitting, so
 * that part is exercised against real `git diff` output rather than pinned by
 * the shape of the source. The rest is pinned the way the rest of this
 * dashboard is: the modules ship as plain ES with no bundler and no DOM to
 * render them into.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { defaultPublicDirectory } from "./assets.js";

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(defaultPublicDirectory(), name), "utf8");
}

interface CodeViewModule {
  splitPatchByFile: (
    patch: unknown,
  ) => Array<{ path: string; patch: string }>;
  patchStats: (patch: string) => { additions: number; deletions: number };
}

async function codeView(): Promise<CodeViewModule> {
  return (await import(
    pathToFileURL(path.join(defaultPublicDirectory(), "code-view.js")).href
  )) as unknown as CodeViewModule;
}

/** A real two-file patch, headers and all, as `git diff` writes it. */
const TWO_FILES = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,4 +1,5 @@",
  " export function retry(attempt: number): number {",
  "-  return 2 ** attempt;",
  "+  // Cap it, or a long outage becomes an infinite wait.",
  "+  return Math.min(2 ** attempt, 30_000);",
  " }",
  "diff --git a/src/session.ts b/src/session.ts",
  "index 3333333..4444444 100644",
  "--- a/src/session.ts",
  "+++ b/src/session.ts",
  "@@ -10,3 +11,3 @@ export class Session {",
  "-  private ttl = 3600;",
  "+  private ttl = 900;",
  " }",
].join("\n");

test("a branch's patch is split into the files it touched", async () => {
  const { splitPatchByFile, patchStats } = await codeView();

  const files = splitPatchByFile(TWO_FILES);
  assert.deepEqual(
    files.map((file) => file.path),
    ["src/retry.ts", "src/session.ts"],
  );

  // Split, not merely labelled: each piece is a patch in its own right, so
  // the line numbers restart from its own hunk header instead of running on
  // from the previous file's.
  assert.deepEqual(patchStats(files[0]?.patch ?? ""), {
    additions: 2,
    deletions: 1,
  });
  assert.deepEqual(patchStats(files[1]?.patch ?? ""), {
    additions: 1,
    deletions: 1,
  });
  // And the `a/` and `b/` git puts on both sides are git's, not the path's.
  assert.equal(
    files.some((file) => file.path.startsWith("b/")),
    false,
  );
});

test("a file that was added, deleted or renamed is still named", async () => {
  const { splitPatchByFile } = await codeView();

  // A deletion has `+++ /dev/null`, so the name has to come off the `---`
  // side or the file reads as an unnamed block of red.
  const deleted = splitPatchByFile(
    [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const gone = true;",
      "-",
    ].join("\n"),
  );
  assert.deepEqual(
    deleted.map((file) => file.path),
    ["src/old.ts"],
  );

  // An addition is the mirror image: `--- /dev/null`, and the name is on the
  // `+++` side, which is the side this reads first anyway.
  const added = splitPatchByFile(
    [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,1 @@",
      "+export const arrived = true;",
    ].join("\n"),
  );
  assert.deepEqual(
    added.map((file) => file.path),
    ["src/new.ts"],
  );

  // A rename names the destination, which is where the reader will look for
  // it, not the source it no longer lives at.
  const renamed = splitPatchByFile(
    [
      "diff --git a/src/a.ts b/src/b.ts",
      "similarity index 96%",
      "rename from src/a.ts",
      "rename to src/b.ts",
      "--- a/src/a.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const b = 1;",
    ].join("\n"),
  );
  assert.deepEqual(
    renamed.map((file) => file.path),
    ["src/b.ts"],
  );
});

test("splitting a patch with nothing in it produces nothing to draw", async () => {
  const { splitPatchByFile } = await codeView();

  for (const empty of ["", "   \n  ", undefined, null, 12]) {
    assert.equal(
      splitPatchByFile(empty).length,
      0,
      `${JSON.stringify(empty)} should split to nothing`,
    );
  }

  // A bare hunk with no headers at all is one file whose name nobody knows —
  // which is what a caller that already knew the name would pass. Dropping it
  // would lose the only diff there was.
  const bare = splitPatchByFile(
    ["@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 2;"].join("\n"),
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0]?.path, "");
  assert.match(String(bare[0]?.patch), /const a = 2;/u);
});

test("the review lists the commits the branch is made of", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  // The commits, from the server rather than derived from the patch — which
  // cannot know who wrote what, or in what order.
  assert.match(chats, /function branchCommitList\(/u);
  assert.match(chats, /review\.commits/u);
  // Each one shows the short revision, the subject, the author and when: the
  // four things somebody scanning a history actually reads.
  assert.match(chats, /branch-commit-sha/u);
  assert.match(chats, /branch-commit-subject/u);
  assert.match(chats, /branch-commit-who/u);
  for (const rule of [
    /\.branch-commits \{/u,
    /\.branch-commit \{/u,
    /\.branch-commit-sha \{/u,
  ]) {
    assert.match(styles, rule);
  }
});

test("the diff is one fold per file, not one wall", async () => {
  const chats = await publicFile("screen-chats.js");
  const styles = await publicFile("styles.css");

  assert.match(chats, /function branchFileReview\(/u);
  assert.match(chats, /splitPatchByFile\(/u);
  // Folded, with the first few open: a branch that touched forty files should
  // not open forty diffs, and one that touched two should not make somebody
  // click twice to see anything.
  assert.match(chats, /BRANCH_FILES_OPEN_BY_DEFAULT = \d+/u);
  assert.match(chats, /<details class="branch-file-review/u);
  // Each fold's header carries what a reader decides on before opening it:
  // the path, whether it conflicts, and how much moved.
  assert.match(chats, /branch-file-path/u);
  assert.match(chats, /branch-file-comments/u);
  assert.match(chats, /branch-conflict/u);
  assert.match(chats, /delta-add/u);
  assert.match(chats, /delta-del/u);
  assert.match(styles, /\.branch-file-review \{/u);
  // A fold has to look like one. `display: flex` on a `<summary>` drops the
  // disclosure triangle in Chromium, which left four rows that opened on a
  // click and gave no sign they would — so the caret is drawn back, and
  // turned when the fold is open.
  assert.match(styles, /\.branch-file-review > summary::before \{/u);
  assert.match(
    styles,
    /\.branch-file-review\[open\] > summary::before \{\s*transform: rotate/u,
  );
});

test("a line can be commented on, and the remark stays on that line", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");
  const styles = await publicFile("styles.css");

  // The affordance sits on the row, and only on rows that exist in the
  // version being commented on: a deleted line is not in the file any more,
  // so a comment pinned to it could never be placed again.
  assert.match(chats, /dline-comment/u);
  assert.match(chats, /commentable/u);
  assert.match(styles, /\.dline\.commentable/u);
  // Hidden until it is wanted, but reachable from the keyboard — `:focus`
  // as well as `:hover`, or the whole surface is mouse-only.
  const rule = styles.slice(styles.indexOf(".dline-comment"));
  assert.match(rule.slice(0, rule.indexOf("}")), /opacity: 0/u);
  assert.match(styles, /\.dline\.commentable:hover \.dline-comment,/u);
  assert.match(styles, /\.dline-comment:focus-visible \{/u);

  // The composer is a div, not a form. The click dispatcher walks up to the
  // nearest `[data-act]`, so a form containing a submit button fires both the
  // dispatcher and the submit handler, and posts the comment twice.
  assert.match(chats, /branch-comment-form/u);
  assert.doesNotMatch(chats, /<form[^>]*data-act="branch-comment/u);
  assert.match(chats, /data-act="branch-comment-submit"/u);

  for (const action of [
    /"branch-comment-open"/u,
    /"branch-comment-cancel"/u,
    /"branch-comment-submit"/u,
  ]) {
    assert.match(app, action);
  }
  // What the server needs to place it: the file, the line, and the revision
  // those two were counted in.
  assert.match(data, /commentOnBranchLine\(/u);
  assert.match(data, /body: \{ path, line, revision, content \}/u);
  assert.match(data, /\/branch\/comments/u);
});

test("a review is an answer somebody can change or take back", async () => {
  const chats = await publicFile("screen-chats.js");
  const data = await publicFile("data.js");
  const app = await publicFile("app.js");
  const styles = await publicFile("styles.css");

  assert.match(chats, /function branchReviewStates\(/u);
  assert.match(chats, /Request changes/u);
  assert.match(chats, /Approve/u);
  // The pressed one is shown as pressed rather than both offered as though
  // neither had been chosen, and pressing it again withdraws.
  assert.match(chats, /review\.myReview/u);
  assert.match(app, /"branch-review-state"/u);
  assert.match(app, /withdrawn/u);
  assert.match(data, /reviewBranch\(/u);
  assert.match(data, /\/branch\/review/u);
  assert.match(styles, /\.branch-reviews \{/u);
  assert.match(styles, /\.branch-actions \.btn\.on \{/u);
});

test("an approval of an older commit does not read as an approval of this one", async () => {
  const chats = await publicFile("screen-chats.js");

  // The server marks each review and each comment `current`. Drawing that is
  // the whole point: an approval from four commits ago is an approval of
  // something else, and showing it plainly beside a fresh one is the single
  // most misleading thing this panel could do.
  assert.match(chats, /entry\.current === false/u);
  assert.match(chats, /comment\.current === false/u);
  assert.match(chats, /on an earlier version of this branch/u);
  assert.match(chats, /left on an earlier version of this line/u);
});
