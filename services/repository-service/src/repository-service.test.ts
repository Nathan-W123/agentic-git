import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitClient,
  GitCommandError,
  type GitRunOptions,
} from "./git-client.js";
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

class FailingRemoteGitClient extends GitClient {
  public override async run(
    args: readonly string[],
    _options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    if (args[0] === "check-ref-format") {
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }
    if (args.includes("rev-parse")) {
      return {
        exitCode: 0,
        stdout: `${"a".repeat(40)}\n`,
        stderr: "",
        durationMs: 1,
      };
    }
    if (args[0] === "ls-remote") {
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: authentication failed",
        durationMs: 1,
      };
    }
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  }
}

test("remote lookup failures are not misclassified as absent branches", async () => {
  const repositories = new RepositoryService(new FailingRemoteGitClient());
  await assert.rejects(
    repositories.pushToRemote(
      { id: "repo", path: "/canonical.git", branch: "main" },
      {
        remoteUrl: "https://example.com/repository.git",
        revision: "a".repeat(40),
        expectedUpstreamRevision: "a".repeat(40),
      },
    ),
    (error: unknown) =>
      error instanceof GitCommandError && error.result.exitCode === 128,
  );
});

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

test("revision metadata and concurrent bundle requests remain deterministic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-bundle-test-"));
  const source = path.join(root, "source");
  const repositories = new RepositoryService();
  try {
    await repositories.initializeWorkingRepository(source);
    await writeFile(path.join(source, "value.txt"), "one\n");
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      path.join(root, "canonical.git"),
      "bundle",
    );
    const canonical = await repositories.getCanonicalVersion(repository);
    assert.deepEqual(
      await repositories.getVersionAtRevision(
        repository,
        canonical.revision,
      ),
      canonical,
    );

    const [first, second] = await Promise.all([
      repositories.createBundle(
        repository,
        canonical.revision,
        "refs/coord/leases/same",
      ),
      repositories.createBundle(
        repository,
        canonical.revision,
        "refs/coord/leases/same",
      ),
    ]);
    assert.ok(first.byteLength > 0);
    assert.deepEqual(first, second);

    // A lease ref belongs outside the branch namespace, so a bare name is
    // refused rather than quietly reinterpreted as `refs/heads/<name>`.
    await assert.rejects(
      repositories.createBundle(repository, canonical.revision, "coord/leases/bare"),
      /fully qualified/u,
    );

    const protectedRef = "refs/coord/leases/protected";
    const git = repositories.getGitClient();
    await git.run([
      `--git-dir=${repository.path}`,
      "update-ref",
      protectedRef,
      canonical.revision,
    ]);
    await assert.rejects(
      repositories.createBundle(
        repository,
        canonical.revision,
        "refs/coord/leases/protected",
      ),
      /already exists and will not be overwritten/u,
    );
    const stillProtected = await git.run([
      `--git-dir=${repository.path}`,
      "rev-parse",
      "--verify",
      protectedRef,
    ]);
    assert.equal(stillProtected.stdout.trim(), canonical.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
