import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitClient, type GitRunOptions } from "./git-client.js";
import type { ProcessOutput } from "./process-runner.js";
import {
  RepositoryService,
  normalizeGitHubRepository,
} from "./repository-service.js";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

test("failed imports do not leave a partial canonical repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repository-test-"));
  const sourcePath = path.join(root, "source");
  const destinationPath = path.join(root, "canonical.git");
  const repositories = new RepositoryService();

  try {
    await repositories.initializeWorkingRepository(sourcePath);
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(path.join(sourcePath, "src", "value.js"), "export {};\n");
    await repositories.commitAll(sourcePath, "seed");

    await assert.rejects(
      repositories.importLocalRepository(
        sourcePath,
        destinationPath,
        "fixture",
        "missing",
      ),
    );
    assert.equal(await pathExists(destinationPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid canonical branch names before importing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-repository-test-"));
  const destinationPath = path.join(root, "canonical.git");
  const repositories = new RepositoryService();

  try {
    await assert.rejects(
      repositories.importLocalRepository(
        root,
        destinationPath,
        "fixture",
        "../outside",
      ),
    );
    assert.equal(await pathExists(destinationPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes GitHub shorthand and rejects credential-bearing URLs", () => {
  assert.equal(
    normalizeGitHubRepository("openai/codex"),
    "https://github.com/openai/codex.git",
  );
  assert.equal(
    normalizeGitHubRepository("git@github.com:openai/codex.git"),
    "git@github.com:openai/codex.git",
  );
  assert.throws(
    () => normalizeGitHubRepository("https://token@github.com/openai/codex"),
    /credential-free/u,
  );
  assert.throws(
    () => normalizeGitHubRepository("https://github.com/openai/codex?token=x"),
    /credential-free/u,
  );
  assert.throws(
    () => normalizeGitHubRepository("https://example.com/openai/codex"),
    /github\.com/u,
  );
});

class CapturingGitClient extends GitClient {
  public args: readonly string[] | undefined;
  public options: GitRunOptions | undefined;

  public override async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    this.args = [...args];
    this.options = options;
    throw new Error("captured clone");
  }
}

test("remote credentials never enter the clone URL or argument list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-remote-test-"));
  const git = new CapturingGitClient();
  const token = "github_pat_secret-value";
  const repositories = new RepositoryService(git);

  try {
    await assert.rejects(
      repositories.importRemoteRepository(
        "https://github.com/openai/codex.git",
        path.join(root, "canonical.git"),
        "codex",
        { credentials: { token } },
      ),
      /captured clone/u,
    );
    assert.deepEqual(git.args?.slice(0, 3), [
      "clone",
      "--bare",
      "https://github.com/openai/codex.git",
    ]);
    assert.equal(JSON.stringify(git.args).includes(token), false);
    assert.equal(git.options?.env?.["GIT_TERMINAL_PROMPT"], "0");
    assert.match(
      git.options?.env?.["GIT_CONFIG_VALUE_0"] ?? "",
      /^Authorization: Basic /u,
    );
    assert.equal(await pathExists(path.join(root, "canonical.git")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote imports reject local and unencrypted transports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-remote-test-"));
  const repositories = new RepositoryService();
  try {
    await assert.rejects(
      repositories.importRemoteRepository(
        "file:///tmp/repository.git",
        path.join(root, "file.git"),
        "file",
      ),
      /HTTPS or SSH/u,
    );
    await assert.rejects(
      repositories.importRemoteRepository(
        "git://example.com/repository.git",
        path.join(root, "git.git"),
        "git",
      ),
      /HTTPS or SSH/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
