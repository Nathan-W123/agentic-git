import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryService } from "@coord/repository-service";

import {
  EPHEMERAL_CLEAN_EXCLUDES,
  GitWorktreeWorkspaceManager,
  isEphemeralWorkspacePath,
} from "./index.js";

test("change collection excludes untracked dependency trees without a gitignore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-changeset-test-"));
  try {
    const sourcePath = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(sourcePath);
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "src", "value.js"),
      "export const value = 1;\n",
      "utf8",
    );
    await repositories.commitAll(sourcePath, "seed");
    const repository = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "fixture",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const workspace = await manager.create({
      taskId: "task_change",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: await repositories.getCanonicalVersion(repository),
    });

    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace.path, "node_modules", "fixture", "package.json"),
      "{}\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, "dist"), { recursive: true });
    await writeFile(
      path.join(workspace.path, "dist", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );

    const changeSet = await manager.collectChangeSet(workspace, {
      expectedFiles: ["src/value.js"],
      symbolsChanged: ["value"],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "updated the value",
    });

    assert.deepEqual(
      changeSet.patches.map((patch) => patch.path),
      ["src/value.js"],
    );
    await manager.destroy(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A scrubbed workspace has to be indistinguishable from a fresh checkout, and
 * the two halves of the scrub have to agree about what that means.
 *
 * Both halves were wrong to start with, and in ways that hid each other:
 * `git clean -fd` honours .gitignore, so a landed task's `.env` and logs
 * stayed, and `git status --porcelain` without `--ignored` cannot see an
 * ignored file, so the verification meant to catch the leak reported a clean
 * directory. Both were confirmed in a scratch repository before either was
 * changed.
 */
test("a scrub returns a workspace to a verified-clean checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-scrub-test-"));
  try {
    const sourcePath = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(sourcePath);
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "src", "value.js"),
      "export const value = 1;\n",
      "utf8",
    );
    await writeFile(
      path.join(sourcePath, ".gitignore"),
      "*.log\n.env\nnode_modules/\n",
      "utf8",
    );
    await repositories.commitAll(sourcePath, "seed");
    const repository = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "fixture",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const workspace = await manager.create({
      taskId: "task_scrub",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: await repositories.getCanonicalVersion(repository),
    });

    await writeFile(
      path.join(workspace.path, "src", "value.js"),
      "export const value = 2;\n",
      "utf8",
    );
    await writeFile(path.join(workspace.path, "scratch.txt"), "notes\n", "utf8");
    await writeFile(path.join(workspace.path, ".env"), "SECRET=1\n", "utf8");
    await writeFile(path.join(workspace.path, "debug.log"), "noisy\n", "utf8");
    await mkdir(path.join(workspace.path, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace.path, "node_modules", "fixture", "index.js"),
      "module.exports = 1;\n",
      "utf8",
    );
    await writeFile(
      path.join(workspace.path, "tsconfig.tsbuildinfo"),
      "{}\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, "pkg", ".yarn", "cache"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace.path, "pkg", ".yarn", "cache", "q.zip"),
      "zip\n",
      "utf8",
    );
    await mkdir(path.join(workspace.path, ".yarn"), { recursive: true });
    await writeFile(
      path.join(workspace.path, ".yarn", "install-state.gz"),
      "state\n",
      "utf8",
    );
    // The intent-to-add entries `collectChangeSet` stages are index state, not
    // working-tree state, and a reset that missed them would have the next
    // task re-offer this one's files as its own work.
    await manager.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "left a mess",
    });

    assert.deepEqual(await manager.scrub(workspace), { clean: true });

    assert.equal(
      await readFile(path.join(workspace.path, "src", "value.js"), "utf8"),
      "export const value = 1;\n",
    );
    for (const gone of ["scratch.txt", ".env", "debug.log"]) {
      await assert.rejects(access(path.join(workspace.path, gone)));
    }
    for (const kept of [
      path.join("node_modules", "fixture", "index.js"),
      "tsconfig.tsbuildinfo",
      path.join("pkg", ".yarn", "cache", "q.zip"),
      path.join(".yarn", "install-state.gz"),
    ]) {
      await access(path.join(workspace.path, kept));
    }
    const after = await manager.collectChangeSet(workspace, {
      symbolsChanged: [],
      riskAssessment: { level: "low", reasons: [] },
      agentExplanation: "nothing",
    });
    assert.deepEqual(after.patches, []);

    await manager.destroy(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A single `-f` deliberately does not delete a nested git repository, because
 * deleting somebody's clone is worse than losing a warm directory. The
 * verification is what keeps it from being handed on regardless.
 */
test("a scrub refuses a workspace holding a nested repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-scrub-nested-"));
  try {
    const sourcePath = path.join(root, "source");
    const repositories = new RepositoryService();
    await repositories.initializeWorkingRepository(sourcePath);
    await writeFile(path.join(sourcePath, "a.txt"), "seed\n", "utf8");
    await repositories.commitAll(sourcePath, "seed");
    const repository = await repositories.importLocalRepository(
      sourcePath,
      path.join(root, "canonical.git"),
      "fixture",
    );
    const manager = new GitWorktreeWorkspaceManager(
      repositories.getGitClient(),
    );
    const workspace = await manager.create({
      taskId: "task_nested",
      rootPath: path.join(root, "workspaces"),
      repository,
      baseVersion: await repositories.getCanonicalVersion(repository),
    });
    await repositories.initializeWorkingRepository(
      path.join(workspace.path, "nested"),
    );

    const result = await manager.scrub(workspace);
    assert.equal(result.clean, false);
    assert.match(result.clean === false ? result.reason : "", /nested/u);

    await manager.destroy(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The excludes `git clean` is given and the filter the verification applies
 * have to agree. If `clean` spares something the filter flags, every retained
 * directory fails verification and is destroyed — safe, and completely
 * useless.
 */
test("every ephemeral clean exclude is one the verification also spares", () => {
  const examples: Record<string, string> = {
    "*.tsbuildinfo": "a.tsbuildinfo",
    "**/.yarn/cache": "pkg/.yarn/cache/z",
    "**/.yarn/unplugged": ".yarn/unplugged/z",
    "**/.yarn/install-state.gz": ".yarn/install-state.gz",
    ".DS_Store": ".DS_Store",
    "Thumbs.db": "dir/Thumbs.db",
  };
  for (const pattern of EPHEMERAL_CLEAN_EXCLUDES) {
    // Everything not listed above is a bare directory name, which git matches
    // at any depth and the filter matches as a path segment.
    const example = examples[pattern] ?? `x/${pattern}/a`;
    assert.ok(
      isEphemeralWorkspacePath(example),
      `${example} is excluded from clean but flagged by the verification`,
    );
  }
});
