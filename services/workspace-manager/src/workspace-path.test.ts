import assert from "node:assert/strict";
import test from "node:test";

import {
  parseNameStatusZ,
  parseUnifiedHunkRanges,
  workspaceDirectoryName,
} from "./index.js";

const UUID_TASK = "task_3647b145-4780-4c2f-8135-4a8122e601ad";
const UUID_WORKSPACE = "workspace_bb49a6d1-8905-415e-8932-6ecc406910bc";

/**
 * The regression: git creates a metadata directory of the same name inside the
 * canonical repository, so an 88-character workspace name is charged twice
 * against the Windows 260-character path limit and `worktree add` fails with
 * "Filename too long" before any repository content exists.
 */
test("a workspace directory name stays short enough for a deep Windows path", () => {
  const name = workspaceDirectoryName(UUID_TASK, UUID_WORKSPACE);
  assert.ok(
    name.length <= 40,
    `expected a bounded directory name, got ${name.length}: ${name}`,
  );
});

test("readable task ids stay readable", () => {
  const name = workspaceDirectoryName("task_cap_value", UUID_WORKSPACE);
  assert.match(name, /^task_cap_value-[a-f0-9]{12}$/u);
});

test("distinct workspaces for one task do not collide", () => {
  const first = workspaceDirectoryName(UUID_TASK, UUID_WORKSPACE);
  const second = workspaceDirectoryName(
    UUID_TASK,
    "workspace_11111111-2222-3333-4444-555555555555",
  );
  assert.notEqual(first, second);
});

test("path separators and traversal cannot enter the directory name", () => {
  const name = workspaceDirectoryName("../../etc/passwd", UUID_WORKSPACE);
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("\\"));
  assert.ok(!name.includes(".."));
});

test("the integration prefix used by the integration service still fits", () => {
  const name = workspaceDirectoryName(
    `integration-${UUID_TASK}`,
    UUID_WORKSPACE,
  );
  assert.ok(name.length <= 40, `got ${name.length}: ${name}`);
});

test("NUL-delimited status output preserves unusual repository paths", () => {
  assert.deepEqual(
    parseNameStatusZ("M\0src/has\ttab.ts\0A\0docs/has\nnewline.md\0"),
    [
      { code: "M", path: "src/has\ttab.ts" },
      { code: "A", path: "docs/has\nnewline.md" },
    ],
  );
});

test("malformed NUL-delimited status output is rejected", () => {
  assert.throws(
    () => parseNameStatusZ("M\0src/file.ts\0A"),
    /Unexpected NUL-delimited/u,
  );
});

test("hunk headers place an edit inside the file it changed", () => {
  // `-U0`: no context, so every header names exactly the lines that changed.
  const diff = [
    "diff --git a/src/server.ts b/src/server.ts",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -120,3 +120,5 @@ function renderChannel() {",
    "+added",
    "@@ -400 +402 @@",
    "-old",
    "+new",
    "diff --git a/src/other.ts b/src/other.ts",
    "--- a/src/other.ts",
    "+++ b/src/other.ts",
    "@@ -1,0 +2,3 @@",
    "+three new lines",
  ].join("\n");

  assert.deepEqual(parseUnifiedHunkRanges(diff), [
    { path: "src/other.ts", ranges: [{ startLine: 2, endLine: 4 }] },
    {
      path: "src/server.ts",
      ranges: [
        { startLine: 120, endLine: 124 },
        // A header with no count is one line.
        { startLine: 402, endLine: 402 },
      ],
    },
  ]);
});

test("a deletion is still somewhere its author has been", () => {
  // "+39,0" is three lines gone and nothing arrived. Recording no range would
  // leave the file looking untouched at the one point somebody edited it.
  const diff = [
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -40,3 +39,0 @@",
    "-gone",
  ].join("\n");

  assert.deepEqual(parseUnifiedHunkRanges(diff), [
    { path: "src/server.ts", ranges: [{ startLine: 39, endLine: 39 }] },
  ]);
});

test("a file the diff deleted outright has no new side to place anything in", () => {
  const diff = [
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,10 +0,0 @@",
    "-everything",
  ].join("\n");

  assert.deepEqual(parseUnifiedHunkRanges(diff), []);
});
