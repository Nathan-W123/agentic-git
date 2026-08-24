import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "./repository-service.js";

/** A repository holding exactly the files given, at canonical. */
async function fixture(
  files: Record<string, Buffer | string>,
): Promise<{
  root: string;
  repositories: RepositoryService;
  repository: Awaited<ReturnType<RepositoryService["importLocalRepository"]>>;
  revision: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-batch-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  await repositories.initializeWorkingRepository(source);
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(source, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  await repositories.commitAll(source, "seed");
  const repository = await repositories.importLocalRepository(
    source,
    path.join(root, "canonical.git"),
    "example",
  );
  const { revision } = await repositories.getCanonicalVersion(repository);
  return { root, repositories, repository, revision };
}

test("answers many paths over one process, in the order asked", async () => {
  const { root, repositories, repository, revision } = await fixture({
    "a.txt": "alpha\n",
    "b.txt": "beta\n",
    "nested/c.txt": "gamma\n",
  });
  try {
    const reader = repositories.openBatchReader(repository, revision);
    try {
      // Deliberately not the order they were written or sorted in.
      const answers = await reader.read(["b.txt", "nested/c.txt", "a.txt"]);
      assert.deepEqual(
        answers.map((entry) => entry?.toString("utf8")),
        ["beta\n", "gamma\n", "alpha\n"],
      );
      // A second call on the same process, because that is the point of it.
      const again = await reader.read(["a.txt"]);
      assert.equal(again[0]?.toString("utf8"), "alpha\n");
    } finally {
      await reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a path that is not a file answers with nothing, not with a listing", async () => {
  const { root, repositories, repository, revision } = await fixture({
    "nested/c.txt": "gamma\n",
  });
  try {
    const reader = repositories.openBatchReader(repository, revision);
    try {
      // `absent` is missing; `nested` resolves, but to a tree. Handing back a
      // directory listing as though it were file contents is how a caller ends
      // up indexing a folder.
      const answers = await reader.read(["absent.txt", "nested", "nested/c.txt"]);
      assert.equal(answers[0], undefined);
      assert.equal(answers[1], undefined);
      assert.equal(answers[2]?.toString("utf8"), "gamma\n");
    } finally {
      await reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contents are framed by length, so newlines and NUL survive", async () => {
  // The framing is the whole risk here. Responses are `<oid> blob <size>` and
  // then exactly that many bytes, so anything that reads to the next newline
  // instead truncates every file that has one — which is every source file.
  const binary = Buffer.from([0, 1, 2, 10, 13, 0, 255, 10]);
  const many = `${"line\n".repeat(5000)}tail`;
  const { root, repositories, repository, revision } = await fixture({
    "binary.bin": binary,
    "many.txt": many,
    "after.txt": "still here\n",
  });
  try {
    const reader = repositories.openBatchReader(repository, revision);
    try {
      const answers = await reader.read(["binary.bin", "many.txt", "after.txt"]);
      assert.deepEqual(answers[0], binary);
      assert.equal(answers[1]?.toString("utf8"), many);
      // The read after a large one: a length mistake shows up as everything
      // downstream being off by a few bytes rather than as a bad first answer.
      assert.equal(answers[2]?.toString("utf8"), "still here\n");
    } finally {
      await reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closing a reader twice is not an error", async () => {
  const { root, repositories, repository, revision } = await fixture({
    "a.txt": "alpha\n",
  });
  try {
    const reader = repositories.openBatchReader(repository, revision);
    await reader.read(["a.txt"]);
    await reader.close();
    await reader.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
