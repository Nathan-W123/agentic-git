import assert from "node:assert/strict";
import test from "node:test";

import {
  parseNameStatusZ,
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
