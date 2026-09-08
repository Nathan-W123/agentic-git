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

/**
 * The branch machinery, against real Git rather than a description of it.
 *
 * Everything here turns on what `git merge-tree --write-tree --name-only`
 * actually prints, and the shape of that output is the whole reason this test
 * exists: the conflicted paths and Git's own commentary about the merge are
 * two sections separated by a *blank line*, so the obvious way to read the
 * output — drop the empty lines, take everything after the tree id — quietly
 * reports "Auto-merging src/login.ts" as a conflicted file. A fixture cannot
 * catch that, because a fixture is written by whoever misread the format.
 */
test("a branch comparison names the files that conflict, and nothing else", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-branch-compare-"));
  const source = path.join(root, "source");
  const canonicalPath = path.join(root, "canonical.git");
  const repositories = new RepositoryService();
  try {
    await repositories.initializeWorkingRepository(source);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(
      path.join(source, "src", "login.ts"),
      "export function clamp(n: number) {\n  return Math.min(n, 80);\n}\n",
    );
    await writeFile(path.join(source, "README.md"), "# demo\n");
    await repositories.commitAll(source, "seed");
    const repository = await repositories.importLocalRepository(
      source,
      canonicalPath,
      "compare",
    );

    // Two branches, one of which touches a file canonical also moves.
    assert.equal(await repositories.ensureBranch(repository, "kumi/clean"), true);
    assert.equal(
      await repositories.ensureBranch(repository, "kumi/clashing"),
      true,
    );
    const git = repositories.getGitClient();
    const commitOnto = async (
      branch: string,
      file: string,
      contents: string,
      message: string,
    ): Promise<void> => {
      const tree = path.join(root, `tree-${branch.replace(/\W/gu, "-")}`);
      await git.run(["clone", "--quiet", "--branch", branch, canonicalPath, tree]);
      await mkdir(path.join(tree, path.dirname(file)), { recursive: true });
      await writeFile(path.join(tree, file), contents);
      await git.run([`-C`, tree, "add", "-A"]);
      await git.run([
        `-C`,
        tree,
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-qm",
        message,
      ]);
      await git.run([`-C`, tree, "push", "--quiet", "origin", branch]);
    };

    await commitOnto("kumi/clean", "docs/notes.md", "notes\n", "Add notes");
    await commitOnto(
      "kumi/clashing",
      "src/login.ts",
      "export function clamp(n: number) {\n  return Math.min(n, 120);\n}\n",
      "Widen to 120",
    );
    await commitOnto(
      repository.branch,
      "src/login.ts",
      "export function clamp(n: number) {\n  return Math.min(n, 100);\n}\n",
      "Widen to 100",
    );

    const clean = await repositories.compareBranches(repository, "kumi/clean");
    assert.equal(clean.ahead, 1);
    assert.equal(clean.behind, 1);
    assert.deepEqual(clean.files, ["docs/notes.md"]);
    assert.deepEqual(clean.conflicts, []);

    const clashing = await repositories.compareBranches(
      repository,
      "kumi/clashing",
    );
    assert.deepEqual(clashing.files, ["src/login.ts"]);
    // The path, and only the path. Git prints "Auto-merging src/login.ts" and
    // "CONFLICT (content): Merge conflict in src/login.ts" after a blank line,
    // and neither is a file anybody can open and fix.
    assert.deepEqual(clashing.conflicts, ["src/login.ts"]);

    // The merge refuses rather than resolving, and says the same thing.
    const refused = await repositories.mergeBranchInto(
      repository,
      "kumi/clashing",
      { message: "Merge kumi/clashing" },
    );
    assert.equal(refused.merged, false);
    assert.deepEqual(
      refused.merged === false ? refused.conflicts : [],
      ["src/login.ts"],
    );

    // And the clean one lands, as a real merge commit with two parents.
    const merged = await repositories.mergeBranchInto(repository, "kumi/clean", {
      message: "Merge kumi/clean",
    });
    assert.equal(merged.merged, true);
    const parents = await git.run([
      `--git-dir=${repository.path}`,
      "rev-list",
      "--parents",
      "-n",
      "1",
      merged.merged === true ? merged.revision : "",
    ]);
    assert.equal(
      parents.stdout.trim().split(/\s+/u).length,
      3,
      "a merge commit has the commit and two parents",
    );
    // Canonical moved to it, and the branch is still there — deleting it is
    // the caller's decision, made after the merge is known to have landed.
    const head = await repositories.getCanonicalVersion(repository);
    assert.equal(head.revision, merged.merged === true ? merged.revision : "");
    assert.equal(await repositories.branchExists(repository, "kumi/clean"), true);

    // Merging the same branch again is a no-op rather than an empty commit:
    // it is already contained, and canonical does not move.
    const again = await repositories.mergeBranchInto(repository, "kumi/clean", {
      message: "Merge kumi/clean",
    });
    assert.equal(again.merged, true);
    assert.equal(
      again.merged === true ? again.revision : "",
      head.revision,
      "a contained branch must not write a second merge commit",
    );

    // Deleting it is allowed; deleting canonical's own branch is not.
    await repositories.deleteBranch(repository, "kumi/clean");
    assert.equal(await repositories.branchExists(repository, "kumi/clean"), false);
    await assert.rejects(
      async () => await repositories.deleteBranch(repository, repository.branch),
      /Refusing to delete the canonical branch/u,
    );

    // And a branch is never handed over: the second creation fails rather
    // than moving somebody else's back to the base.
    assert.equal(
      await repositories.ensureBranch(repository, "kumi/clashing"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
