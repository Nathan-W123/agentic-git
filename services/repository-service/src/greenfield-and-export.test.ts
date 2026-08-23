import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitClient, type GitRunOptions } from "./git-client.js";
import type { ProcessOutput } from "./process-runner.js";
import {
  RepositoryService,
  SyncDivergedError,
  sanitisePushBranchName,
  type PushBranchNamer,
} from "./repository-service.js";

/* -------------------------------------------------------------------------
 * Greenfield initialization
 *
 * A new project starts as an empty folder, but import needs
 * `refs/heads/<branch>` to exist. These cover the cases that previously failed
 * outright, and the case that must keep failing.
 * ---------------------------------------------------------------------- */

test("a plain empty directory is initialized and imported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green-"));
  try {
    const repositories = new RepositoryService();
    const canonical = await repositories.importLocalRepository(
      path.join(root, "brand-new"),
      path.join(root, "canon.git"),
      "green",
      "main",
    );

    const version = await repositories.getCanonicalVersion(canonical);
    assert.equal(version.branch, "main");
    assert.equal(version.revision.length, 40);
    // The commit exists but is empty, because the directory was.
    assert.deepEqual(await repositories.listFiles(canonical, version.revision), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a git repository with zero commits is given an initial commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green2-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "initialised");
    await repositories.initializeWorkingRepository(source, "main");
    // Deliberately no commit: this is the case that used to fail outright.

    const canonical = await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green2",
      "main",
    );
    assert.equal(
      (await repositories.getCanonicalVersion(canonical)).revision.length,
      40,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files already present become the first commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green3-"));
  try {
    const source = path.join(root, "scaffold");
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "app.js"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(source, "README.md"), "# scaffold\n", "utf8");

    const repositories = new RepositoryService();
    const canonical = await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green3",
      "main",
    );
    const version = await repositories.getCanonicalVersion(canonical);
    assert.deepEqual(
      (await repositories.listFiles(canonical, version.revision)).sort(),
      ["README.md", "src/app.js"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository with history but no matching branch is still refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green4-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "existing");
    await repositories.initializeWorkingRepository(source, "develop");
    await writeFile(path.join(source, "a.txt"), "a\n", "utf8");
    await repositories.commitAll(source, "seed");

    // Inventing a commit here would hide that the branch genuinely is absent.
    await assert.rejects(
      repositories.importLocalRepository(
        source,
        path.join(root, "canon.git"),
        "green4",
        "main",
      ),
      /has commits but no main branch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing repository with history is left untouched by import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-green5-"));
  try {
    const repositories = new RepositoryService();
    const source = path.join(root, "existing");
    await repositories.initializeWorkingRepository(source, "main");
    await writeFile(path.join(source, "a.txt"), "a\n", "utf8");
    await repositories.commitAll(source, "seed");
    const before = await new GitClient().run(["-C", source, "rev-parse", "HEAD"]);

    await repositories.importLocalRepository(
      source,
      path.join(root, "canon.git"),
      "green5",
      "main",
    );

    // No extra commit was manufactured on top of real history.
    const after = await new GitClient().run(["-C", source, "rev-parse", "HEAD"]);
    assert.equal(after.stdout.trim(), before.stdout.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Push / export
 *
 * normalizeRemoteUrl deliberately refuses file:// and git:// so a
 * user-supplied import URL can never reach local paths. Rather than relax that
 * for testing, the git client is subclassed to resolve one fake HTTPS host to
 * a local bare repository. Production validation is untouched, and real git
 * still performs every clone, ls-remote, and push.
 * ---------------------------------------------------------------------- */

const LOOPBACK_HOST = "https://push.invalid/origin.git";

class LoopbackGitClient extends GitClient {
  public constructor(private readonly localRemote: string) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<ProcessOutput> {
    return await super.run(
      args.map((arg) => (arg === LOOPBACK_HOST ? this.localRemote : arg)),
      options,
    );
  }
}

interface PushFixture {
  root: string;
  remotePath: string;
  repositories: RepositoryService;
  canonical: { id: string; path: string; branch: string };
}

async function pushFixture(): Promise<PushFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coord-push-"));
  const plain = new RepositoryService();

  const seed = path.join(root, "seed");
  await plain.initializeWorkingRepository(seed, "main");
  await writeFile(path.join(seed, "a.txt"), "one\n", "utf8");
  await plain.commitAll(seed, "seed");

  const remotePath = path.join(root, "origin.git");
  await new GitClient().run(["clone", "--bare", seed, remotePath]);

  const repositories = new RepositoryService(new LoopbackGitClient(remotePath));
  const canonical = await repositories.importRemoteRepository(
    LOOPBACK_HOST,
    path.join(root, "canon.git"),
    "origin",
    { branch: "main" },
  );
  return { root, remotePath, repositories, canonical };
}

/** Adds a coordinator commit on top of canonical, as an integration would. */
async function advanceCanonical(
  fixture: PushFixture,
  file = "b.txt",
  content = "two\n",
  message =
    "coord(task_12345678-1234-1234-1234-123456789012): Improve push branch naming with readable summaries",
): Promise<string> {
  const git = new GitClient();
  const work = path.join(fixture.root, `work-${Math.random().toString(36).slice(2, 8)}`);
  await git.run(["clone", "--branch", "main", fixture.remotePath, work]);
  // The clone only has what the fixture seeded, so a nested path needs its
  // directory made before the write — otherwise the helper ENOENTs on any
  // test that names a file outside the repository root.
  const target = path.join(work, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await fixture.repositories.commitAll(work, message);
  await git.run([
    `--git-dir=${fixture.canonical.path}`,
    "fetch",
    work,
    "HEAD:refs/heads/main",
    "--force",
  ]);
  const head = await git.run(["-C", work, "rev-parse", "HEAD"]);
  return head.stdout.trim();
}

/** Lands a commit on the origin's main, as a merged GitHub PR would. */
async function advanceRemote(
  fixture: PushFixture,
  file = "c.txt",
  content = "three\n",
): Promise<string> {
  const git = new GitClient();
  const work = path.join(
    fixture.root,
    `remote-${Math.random().toString(36).slice(2, 8)}`,
  );
  await git.run(["clone", "--branch", "main", fixture.remotePath, work]);
  // The clone only has what the fixture seeded, so a nested path needs its
  // directory made before the write — otherwise the helper ENOENTs on any
  // test that names a file outside the repository root.
  const target = path.join(work, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await fixture.repositories.commitAll(work, "github work");
  await git.run(["-C", work, "push", "origin", "main"]);
  const head = await git.run(["-C", work, "rev-parse", "HEAD"]);
  return head.stdout.trim();
}

test("remote import records the upstream tip as the import point", async () => {
  const fixture = await pushFixture();
  try {
    const version = await fixture.repositories.getCanonicalVersion(fixture.canonical);
    assert.deepEqual(
      await fixture.repositories.listFiles(fixture.canonical, version.revision),
      ["a.txt"],
    );
    assert.equal(
      await fixture.repositories.importedRevision(fixture.canonical, "main"),
      version.revision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonical state pushes to a dedicated branch, never over the source", async () => {
  const fixture = await pushFixture();
  try {
    const expected = await advanceCanonical(fixture);
    const mainBefore = await new GitClient().run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);

    const result = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });

    assert.equal(result.targetBranch, "coord/improve-push-branch-naming");
    assert.equal(
      result.summary,
      "Improve push branch naming with readable summaries",
    );
    assert.equal(result.createdBranch, true);
    assert.equal(result.revision, expected);

    // The export branch landed and the imported branch is untouched.
    const refs = await new GitClient().run([
      "ls-remote",
      "--heads",
      fixture.remotePath,
    ]);
    assert.ok(refs.stdout.includes(result.targetBranch));
    const mainAfter = await new GitClient().run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);
    assert.equal(mainAfter.stdout.trim(), mainBefore.stdout.trim());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("push naming is sanitized, bounded, and falls back to changed files", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(
      fixture,
      "src/push branch.ts",
      "export const summary = true;\n",
      "Sync main from origin: merge 1234567890abcdef into canonical",
    );

    const result = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });

    assert.equal(result.summary, "Update src/push branch.ts");
    assert.equal(result.targetBranch, "coord/update-src-push-branch");
    assert.ok(result.targetBranch.length < 40);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the local model names the pushed branch when there is one", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);
    const prompts: string[] = [];
    const namer: PushBranchNamer = async (prompt) => {
      prompts.push(prompt);
      // What a small model actually replies with: a label, quotes, and a
      // sentence of its own afterwards.
      return 'Branch name: "Readable Branch Names"\nThis names the branch.';
    };

    const result = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      branchNamer: namer,
    });

    assert.equal(result.targetBranch, "coord/readable-branch-names");
    // The facts are untouched: only the label the branch carries changed.
    assert.equal(
      result.summary,
      "Improve push branch naming with readable summaries",
    );
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]?.includes("Improve push branch naming"));
    const refs = await new GitClient().run([
      "ls-remote",
      "--heads",
      fixture.remotePath,
    ]);
    assert.ok(refs.stdout.includes("coord/readable-branch-names"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a model that fails or says nothing leaves the deterministic name", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);

    const thrown = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      branchNamer: async () => {
        throw new Error("no model here");
      },
    });
    assert.equal(thrown.targetBranch, "coord/improve-push-branch-naming");

    // A blank reply and a reply with no words in it are the same answer as no
    // model at all, and neither may leave the branch called "coord/".
    for (const reply of ["", "   ", "```\n\n```", undefined]) {
      const fallback = await fixture.repositories.pushToRemote(
        fixture.canonical,
        {
          remoteUrl: LOOPBACK_HOST,
          allowExistingTarget: true,
          branchNamer: async () => reply,
        },
      );
      assert.equal(fallback.targetBranch, "coord/improve-push-branch-naming");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an explicitly named branch is never sent to the model", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);
    let asked = 0;
    const result = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/chosen-by-hand",
      branchNamer: async () => {
        asked += 1;
        return "something-else";
      },
    });

    assert.equal(result.targetBranch, "coord/chosen-by-hand");
    assert.equal(asked, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a model can choose a branch name's words but never its shape", () => {
  assert.equal(
    sanitisePushBranchName("  refs/heads/../Bad Name  "),
    "refs-heads-bad-name",
  );
  assert.equal(sanitisePushBranchName("coord/already-prefixed"), "already-prefixed");
  assert.equal(
    sanitisePushBranchName("a-very-long-branch-name-that-keeps-going-and-going"),
    "very-long-branch-name",
  );
  assert.equal(sanitisePushBranchName("!!! ???"), undefined);
  assert.equal(sanitisePushBranchName(null), undefined);
  assert.equal(sanitisePushBranchName(undefined), undefined);
});

test("a push is refused when the remote moved since import", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);

    // Somebody else commits on the remote after the import.
    const git = new GitClient();
    const other = path.join(fixture.root, "other");
    await git.run(["clone", "--branch", "main", fixture.remotePath, other]);
    await writeFile(path.join(other, "theirs.txt"), "theirs\n", "utf8");
    await fixture.repositories.commitAll(other, "upstream work");
    await git.run(["-C", other, "push", "origin", "main"]);

    await assert.rejects(
      fixture.repositories.pushToRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
      }),
      (error: unknown) => {
        assert.equal((error as Error).name, "UpstreamChangedError");
        assert.match((error as Error).message, /has moved since import/u);
        assert.match((error as Error).message, /could bury/u);
        return true;
      },
    );

    // Nothing was published by the refused attempt.
    const refs = await git.run(["ls-remote", "--heads", fixture.remotePath]);
    assert.ok(!refs.stdout.includes("coord/export-"));

    // An explicitly reviewed upstream revision is the escape hatch.
    const current = await git.run([
      `--git-dir=${fixture.remotePath}`,
      "rev-parse",
      "refs/heads/main",
    ]);
    const reviewed = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      expectedUpstreamRevision: current.stdout.trim(),
      targetBranch: "coord/reviewed",
    });
    assert.equal(reviewed.targetBranch, "coord/reviewed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push without a recorded import point is refused unless allowed", async () => {
  const fixture = await pushFixture();
  try {
    // A locally imported repository has no upstream baseline.
    const local = await fixture.repositories.importLocalRepository(
      path.join(fixture.root, "seed"),
      path.join(fixture.root, "local.git"),
      "local",
      "main",
    );
    assert.equal(await fixture.repositories.importedRevision(local), undefined);

    await assert.rejects(
      fixture.repositories.pushToRemote(local, { remoteUrl: LOOPBACK_HOST }),
      /No import point is recorded/u,
    );

    const allowed = await fixture.repositories.pushToRemote(local, {
      remoteUrl: LOOPBACK_HOST,
      allowUnverifiedUpstream: true,
      targetBranch: "coord/unverified",
    });
    assert.equal(allowed.targetBranch, "coord/unverified");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an existing target branch is not overwritten by default", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);
    await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/export-fixed",
    });

    await assert.rejects(
      fixture.repositories.pushToRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
        targetBranch: "coord/export-fixed",
      }),
      /already has a coord\/export-fixed branch/u,
    );

    // Opting in updates it, and still without forcing.
    const updated = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/export-fixed",
      allowExistingTarget: true,
    });
    assert.equal(updated.createdBranch, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push never force-updates the remote", async () => {
  const fixture = await pushFixture();
  const seen: string[][] = [];
  try {
    await advanceCanonical(fixture);
    const recording = new (class extends LoopbackGitClient {
      public override async run(
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<ProcessOutput> {
        seen.push([...args]);
        return await super.run(args, options);
      }
    })(fixture.remotePath);

    await new RepositoryService(recording).pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/no-force",
    });

    const pushes = seen.filter((args) => args.includes("push"));
    assert.equal(pushes.length, 1);
    for (const args of pushes) {
      assert.ok(!args.some((arg) => /^(--force|-f)$/u.test(arg)), args.join(" "));
      // A leading plus in a refspec is also a force; neither form is allowed.
      assert.ok(!args.some((arg) => arg.startsWith("+")), args.join(" "));
      assert.ok(args.some((arg) => arg.includes(":refs/heads/coord/no-force")));
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a push token never reaches the argument list or the repository", async () => {
  const fixture = await pushFixture();
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  try {
    await advanceCanonical(fixture);
    const recording = new (class extends LoopbackGitClient {
      public override async run(
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<ProcessOutput> {
        calls.push({ args: [...args], env: options.env });
        return await super.run(args, options);
      }
    })(fixture.remotePath);

    await new RepositoryService(recording).pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      targetBranch: "coord/with-token",
      credentials: { token: "ghp_supersecret_value" },
    });

    for (const call of calls) {
      assert.ok(
        !call.args.some((arg) => arg.includes("ghp_supersecret_value")),
        `token leaked into arguments: ${call.args.join(" ")}`,
      );
    }
    // It travels only as an Authorization header in the child environment.
    const authenticated = calls.filter(
      (call) => call.env?.["GIT_CONFIG_VALUE_0"] !== undefined,
    );
    assert.ok(authenticated.length > 0);
    for (const call of authenticated) {
      assert.match(call.env?.["GIT_CONFIG_KEY_0"] ?? "", /http\.extraHeader/u);
      assert.ok(
        !(call.env?.["GIT_CONFIG_VALUE_0"] ?? "").includes("ghp_supersecret_value"),
      );
    }

    // And nothing on disk in the canonical mirror records it.
    const config = await readFile(path.join(fixture.canonical.path, "config"), "utf8");
    assert.ok(!config.includes("ghp_supersecret_value"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Sync from remote
 *
 * The missing half of export: work merged on GitHub leaves the mirror
 * behind, push rightly refuses, and until sync existed the only remedy was
 * a fresh import under a new name.
 * ---------------------------------------------------------------------- */

test("a remote that moved ahead fast-forwards canonical and unblocks push", async () => {
  const fixture = await pushFixture();
  try {
    const remoteTip = await advanceRemote(fixture);

    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
    });
    assert.equal(synced.status, "fast_forwarded");
    assert.equal(synced.revision, remoteTip);
    assert.equal(
      (await fixture.repositories.getCanonicalVersion(fixture.canonical)).revision,
      remoteTip,
    );
    // The import point moved with it — which is exactly what lets the next
    // push proceed.
    assert.equal(
      await fixture.repositories.importedRevision(fixture.canonical, "main"),
      remoteTip,
    );
    await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });

    // Nothing left behind in refs/coord beyond the import point.
    const refs = await new GitClient().run([
      `--git-dir=${fixture.canonical.path}`,
      "for-each-ref",
      "refs/coord/upstream/",
    ]);
    assert.equal(refs.stdout.trim(), "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a sync with nothing new reports already_current", async () => {
  const fixture = await pushFixture();
  try {
    const before = await fixture.repositories.getCanonicalVersion(fixture.canonical);
    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
    });
    assert.equal(synced.status, "already_current");
    assert.equal(synced.revision, before.revision);
    assert.equal(
      (await fixture.repositories.getCanonicalVersion(fixture.canonical)).revision,
      before.revision,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("diverged histories are joined with a merge, and push works after", async () => {
  const fixture = await pushFixture();
  try {
    // The reported shape: agents landed work in canonical, and the person
    // merged pull requests on GitHub — both sides moved.
    const localTip = await advanceCanonical(fixture);
    const remoteTip = await advanceRemote(fixture);

    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
    });
    assert.equal(synced.status, "merged");
    assert.equal(synced.upstreamRevision, remoteTip);
    assert.equal(synced.previousRevision, localTip);

    // Both histories survive beneath the merge — nothing squashed away.
    const git = new GitClient();
    for (const parent of [localTip, remoteTip]) {
      const contains = await git.run(
        [
          `--git-dir=${fixture.canonical.path}`,
          "merge-base",
          "--is-ancestor",
          parent,
          synced.revision,
        ],
        { allowFailure: true },
      );
      assert.equal(contains.exitCode, 0, `${parent} lost in the merge`);
    }
    const version = await fixture.repositories.getCanonicalVersion(fixture.canonical);
    assert.equal(version.revision, synced.revision);
    assert.deepEqual(
      (await fixture.repositories.listFiles(fixture.canonical, version.revision)).sort(),
      ["a.txt", "b.txt", "c.txt"],
    );

    const pushed = await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });
    assert.equal(pushed.revision, synced.revision);
    assert.equal(pushed.targetBranch, "coord/improve-push-branch-naming");
    assert.equal(
      pushed.summary,
      "Improve push branch naming with readable summaries",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a conflicting sync refuses, names the files, and changes nothing", async () => {
  const fixture = await pushFixture();
  try {
    const localTip = await advanceCanonical(fixture, "a.txt", "local change\n");
    await advanceRemote(fixture, "a.txt", "github change\n");
    const baselineBefore = await fixture.repositories.importedRevision(
      fixture.canonical,
      "main",
    );

    await assert.rejects(
      fixture.repositories.syncFromRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
        workspaceRoot: fixture.root,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SyncDivergedError);
        assert.deepEqual(error.conflicts, ["a.txt"]);
        assert.match(error.message, /Nothing was changed/u);
        return true;
      },
    );

    // Canonical and the import point are exactly as they were: push stays
    // refused until a person resolves the overlap on one side.
    assert.equal(
      (await fixture.repositories.getCanonicalVersion(fixture.canonical)).revision,
      localTip,
    );
    assert.equal(
      await fixture.repositories.importedRevision(fixture.canonical, "main"),
      baselineBefore,
    );
    await assert.rejects(
      fixture.repositories.pushToRemote(fixture.canonical, {
        remoteUrl: LOOPBACK_HOST,
      }),
      /has moved since import/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a collision can be settled by taking GitHub's side, keeping both parents", async () => {
  const fixture = await pushFixture();
  try {
    const localTip = await advanceCanonical(fixture, "a.txt", "local change\n");
    const remoteTip = await advanceRemote(fixture, "a.txt", "github change\n");

    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
      conflictResolution: "prefer-remote",
    });

    assert.equal(synced.status, "merged");
    assert.deepEqual(synced.resolved, { side: "remote", files: ["a.txt"] });

    const git = new GitClient();
    const contents = await git.run([
      `--git-dir=${fixture.canonical.path}`,
      "show",
      `${synced.revision}:a.txt`,
    ]);
    assert.equal(contents.stdout.trim(), "github change");
    // Nothing was rewritten away: the losing side is still a parent, so its
    // content stays reachable.
    for (const parent of [localTip, remoteTip]) {
      const contains = await git.run(
        [
          `--git-dir=${fixture.canonical.path}`,
          "merge-base",
          "--is-ancestor",
          parent,
          synced.revision,
        ],
        { allowFailure: true },
      );
      assert.equal(contains.exitCode, 0, `${parent} lost in the merge`);
    }
    // And the push it was blocking now goes through.
    await fixture.repositories.pushToRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the same collision can be settled the other way", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture, "a.txt", "local change\n");
    await advanceRemote(fixture, "a.txt", "github change\n");

    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
      conflictResolution: "prefer-local",
    });

    assert.deepEqual(synced.resolved, { side: "local", files: ["a.txt"] });
    const contents = await new GitClient().run([
      `--git-dir=${fixture.canonical.path}`,
      "show",
      `${synced.revision}:a.txt`,
    ]);
    assert.equal(contents.stdout.trim(), "local change");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a clean merge reports no resolution, because it decided nothing", async () => {
  const fixture = await pushFixture();
  try {
    await advanceCanonical(fixture);
    await advanceRemote(fixture);

    // Offered a resolution it never needs: the files do not overlap.
    const synced = await fixture.repositories.syncFromRemote(fixture.canonical, {
      remoteUrl: LOOPBACK_HOST,
      workspaceRoot: fixture.root,
      conflictResolution: "prefer-remote",
    });

    assert.equal(synced.status, "merged");
    assert.equal(synced.resolved, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
